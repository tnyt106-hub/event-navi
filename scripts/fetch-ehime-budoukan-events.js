const path = require("path");
const { fetchHtml } = require("./lib/http");
const { saveEventJson } = require("./lib/io");
const { decodeHtmlEntities, stripTags } = require("./lib/text");
// --- 新設・強化した共通ライブラリをインポート ---
const { createEvent, createRootStructure } = require("./lib/schema");
const { extractDateRange } = require("./lib/date");

const VENUE_ID = "ehime-budoukan";
const TARGET_URL = "https://ehime-spa.jp/budoukan/martial-event/"; 
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", `${VENUE_ID}.json`);

async function main() {
  try {
    const html = await fetchHtml(TARGET_URL);
    if (!html) throw new Error("HTML取得失敗");

    let fullText = decodeHtmlEntities(stripTags(html));
    fullText = fullText.replace(/\s+/g, " ").trim();

    const events = [];
    const datePattern = /(\d{1,2})\/(\d{1,2})\s*\([月火水木金土日]\)/g;
    let match;
    const blocks = [];

    // 日付を基点にテキストを分割するロジックは継続（武道館特有のため）
    while ((match = datePattern.exec(fullText)) !== null) {
      blocks.push({
        index: match.index,
        rawDate: match[0] // 例: "2/1(日)"
      });
    }

    for (let i = 0; i < blocks.length; i++) {
      const start = blocks[i].index + blocks[i].rawDate.length;
      const end = blocks[i + 1] ? blocks[i + 1].index : fullText.length;
      let rawContent = fullText.substring(start, end).trim();

      const titlePart = rawContent.split(/施設|主催|主管|TEL|日時|競輪情報/)[0]
                                  .replace(/^(行事|名称|大会名)\s*/, "").trim();
      const venueName = (rawContent.match(/施設\s*([^\s]+)/) || [])[1] || null;
      const organizer = (rawContent.match(/主催・主管\s*([^\s]+)/) || [])[1] || null;

      if (titlePart && titlePart.length > 1 && !titlePart.includes("休館日")) {
        
        // --- 強化版 date.js を使用 ---
        // 自前の年越し判定やpadStartが不要に
        const range = extractDateRange(blocks[i].rawDate);
        
        if (range) {
          // --- schema.js を使用 ---
          // 項目の並び順や null 埋めを自動化
          events.push(createEvent({
            title: titlePart,
            date_from: range.date_from,
            date_to: range.date_to,
            description: venueName ? `会場: ${venueName}` : null,
            contact: organizer,
            source_url: TARGET_URL
          }));
        }
      }
    }

    // 重複除去
    const uniqueEvents = Array.from(new Map(
      events.map(e => [`${e.date_from}-${e.title}`, e])
    ).values());

    // --- schema.js でルート構造を作成 ---
    const resultData = createRootStructure(VENUE_ID, uniqueEvents);

    saveEventJson(OUTPUT_PATH, resultData);
    console.log(`[SUCCESS] Refactored with schema.js and date.js.`);

  } catch (error) {
    console.error(`[FATAL] ${error.message}`);
    process.exit(1);
  }
}

main();
