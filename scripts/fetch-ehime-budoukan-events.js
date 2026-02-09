const path = require("path");
const { fetchHtml } = require("./lib/http");
const { finalizeAndSaveEvents } = require("./lib/fetch_output");
const { handleCliFatalError } = require("./lib/cli_error");
const { decodeHtmlEntities, stripTags } = require("./lib/text");
const { createEvent } = require("./lib/schema");
const { extractDateRange } = require("./lib/date");

const VENUE_ID = "ehime-budoukan";
const TARGET_URL = "https://ehime-spa.jp/budoukan/martial-event/";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", `${VENUE_ID}.json`);

/**
 * 正規表現の定義（静的コンパイルで高速化）
 */
const DATE_PATTERN = /(\d{1,2})\/(\d{1,2})\s*\([月火水木金土日]\)/g;
// タイトルの終わりを告げるキーワード
const DELIMITER_PATTERN = /施設|主催|主管|TEL|日時|競輪情報/;
// 先頭のラベル削除用
const PREFIX_PATTERN = /^(行事|名称|大会名)[\s：:：]*/;
// 末尾のゴミ掃除用
const SUFFIX_CLEANUP_PATTERN = /[\s：:：]+$/;
// 個別情報抽出用
const VENUE_PATTERN = /施設\s*([^\s]+)/;
const ORGANIZER_PATTERN = /主催・主管\s*([^\s]+)/;

async function main() {
  try {
    console.log(`[fetch] ターゲットURL取得中: ${TARGET_URL}`);
    const html = await fetchHtml(TARGET_URL);
    if (!html) throw new Error("HTMLの取得に失敗しました。");

    // 1. テキストの正規化
    let fullText = decodeHtmlEntities(stripTags(html))
                    .replace(/\s+/g, " ")
                    .trim();

    const events = [];
    const blocks = [];
    let match;

    // 2. 日付を起点にテキストをスライスするためのインデックスを取得
    while ((match = DATE_PATTERN.exec(fullText)) !== null) {
      blocks.push({ index: match.index, rawDate: match[0] });
    }

    // 3. 各イベントブロックの解析
    for (let i = 0; i < blocks.length; i++) {
      const currentBlock = blocks[i];
      const start = currentBlock.index + currentBlock.rawDate.length;
      const end = blocks[i + 1] ? blocks[i + 1].index : fullText.length;
      
      const rawContent = fullText.substring(start, end).trim();

      // --- タイトル抽出（不純物除去ロジック） ---
      const firstDelimiterMatch = rawContent.match(DELIMITER_PATTERN);
      let titlePart = firstDelimiterMatch 
        ? rawContent.substring(0, firstDelimiterMatch.index) 
        : rawContent;

      titlePart = titlePart
        .replace(PREFIX_PATTERN, "")     
        .replace(SUFFIX_CLEANUP_PATTERN, "") 
        .trim();

      // 「休館日」や短すぎる文字列を除外
      if (titlePart && titlePart.length > 1 && !titlePart.includes("休館日")) {
        const venueMatch = rawContent.match(VENUE_PATTERN);
        const organizerMatch = rawContent.match(ORGANIZER_PATTERN);
        
        const venueName = venueMatch ? venueMatch[1] : null;
        const organizer = organizerMatch ? organizerMatch[1] : null;

        const range = extractDateRange(currentBlock.rawDate);
        
        if (range) {
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

    // 4. 重複除去
    const uniqueEvents = Array.from(new Map(
      events.map(e => [`${e.date_from}-${e.title}`, e])
    ).values());

    // 5. 保存
    // 保存処理は共通関数に統一し、イベントJSONの項目揺れを防ぐ。
    finalizeAndSaveEvents({
      venueId: VENUE_ID,
      outputPath: OUTPUT_PATH,
      events: uniqueEvents,
    });

    console.log(`[SUCCESS] 抽出完了: ${uniqueEvents.length} 件のイベントを保存しました。`);

  } catch (error) {
    handleCliFatalError(error, { prefix: "[FATAL]" });
  }
}

if (require.main === module) {
  main();
}
