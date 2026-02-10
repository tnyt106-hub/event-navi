const path = require("path");
const cheerio = require("cheerio");
const { fetchHtml } = require("../lib/http");
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
const { handleCliFatalError } = require("../lib/cli_error");
const { normalizeWhitespace } = require("../lib/text");
const { createEvent, validateFinalData } = require("../lib/schema");

const VENUE_ID = "asty-tokushima";
const BASE_URL = "https://www.asty-tokushima.jp";
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", `${VENUE_ID}.json`);

// 並列実行数（サーバーへの優しさと速さのバランス）
const CONCURRENCY = 3;

async function main() {
  try {
    console.log(`[START] ${VENUE_ID} (High Speed Mode)`);
    const startTime = Date.now();
    
    // 1. 対象年月のリストアップ（13ヶ月分）
    const targetMonths = [];
    const now = new Date();
    for (let i = -3; i <= 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      targetMonths.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
    }

    // 2. 一覧取得（ここは月数が少ないので直列でOK）
    const allEventItems = [];
    for (const ym of targetMonths) {
      const monthUrl = `${BASE_URL}/event/${ym}/table.html`;
      const html = await fetchHtml(monthUrl);
      if (!html) continue;

      const $ = cheerio.load(html);
      $(".event").each((i, el) => {
        const title = normalizeWhitespace($(el).text());
        if (!title || title.includes("休館日")) return;
        const href = $(el).find("a").attr("href");
        const source_url = href ? new URL(href, BASE_URL).href : null;
        const dateLink = $(el).closest("td").find(".daily a").attr("href");
        let date_from = "";
        if (dateLink) {
          const match = dateLink.match(/(\d{8})/);
          if (match) {
            const d = match[1];
            date_from = `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
          }
        }
        if (title && date_from && source_url) {
          allEventItems.push({ title, date_from, source_url });
        }
      });
    }

    const uniqueItems = Array.from(new Map(allEventItems.map(item => [`${item.date_from}-${item.title}`, item])).values());
    console.log(`  一覧取得完了: ${uniqueItems.length}件。詳細の並列取得を開始します...`);

    // 3. 詳細ページの並列取得（CONCURRENCYずつ実行）
    const finalEvents = [];
    for (let i = 0; i < uniqueItems.length; i += CONCURRENCY) {
      const chunk = uniqueItems.slice(i, i + CONCURRENCY);
      
      const chunkResults = await Promise.all(chunk.map(async (item) => {
        const detailHtml = await fetchHtml(item.source_url);
        let time_start = null, price = null, description = "", location = "";

        if (detailHtml) {
          const $d = cheerio.load(detailHtml);
          $d("table tr").each((_, el) => {
            const label = normalizeWhitespace($d(el).find("th").text());
            const value = normalizeWhitespace($d(el).find("td").text());
            if (label === "日時") {
              const timeMatch = value.match(/開演(\d{1,2}:\d{2})/);
              time_start = timeMatch ? timeMatch[1] : (value.match(/(\d{1,2}:\d{2})/) || [])[1];
            } else if (label === "開催場所") location = value;
            else if (label === "入場料等") price = value;
            else if (label === "イベント内容") description = value;
          });
        }
        return createEvent({
          ...item,
          date_to: item.date_from,
          time_start,
          price,
          description: [location ? `会場: ${location}` : "", description].filter(Boolean).join("\n") || null
        });
      }));

      finalEvents.push(...chunkResults);
      console.log(`    Progress: ${finalEvents.length} / ${uniqueItems.length}`);
      // チャンクごとに少しだけ待機
      await new Promise(r => setTimeout(r, 500));
    }

    validateFinalData(finalEvents, { minEvents: 1 });
    // 保存処理は共通関数に統一し、last_success_at などの整形を一元化する。
    finalizeAndSaveEvents({
      venueId: VENUE_ID,
      outputPath: OUTPUT_PATH,
      events: finalEvents,
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[SUCCESS] ${VENUE_ID}: ${finalEvents.length}件を ${duration}秒 で処理しました。`);

  } catch (error) {
    handleCliFatalError(error, { prefix: "[ERROR]" });
  }
}

if (require.main === module) {
  main();
}
