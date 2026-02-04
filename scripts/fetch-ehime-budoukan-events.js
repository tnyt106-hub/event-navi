const path = require("path");
const { fetchHtml } = require("./lib/http");
const { saveEventJson } = require("./lib/io");
const { decodeHtmlEntities, normalizeWhitespace, stripTags } = require("./lib/text");

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
    const today = new Date();
    const year = today.getFullYear();

    const datePattern = /(\d{1,2})\/(\d{1,2})\s*\([月火水木金土日]\)/g;
    let match;
    const blocks = [];

    while ((match = datePattern.exec(fullText)) !== null) {
      blocks.push({
        index: match.index,
        m: parseInt(match[1], 10),
        d: parseInt(match[2], 10),
        prefix: match[0]
      });
    }

    for (let i = 0; i < blocks.length; i++) {
      const start = blocks[i].index + blocks[i].prefix.length;
      const end = blocks[i + 1] ? blocks[i + 1].index : fullText.length;
      let rawContent = fullText.substring(start, end).trim();

      const titlePart = rawContent.split(/施設|主催|主管|TEL|日時|競輪情報/)[0]
                                  .replace(/^(行事|名称|大会名)\s*/, "").trim();
      const venueName = (rawContent.match(/施設\s*([^\s]+)/) || [])[1] || null;
      const organizer = (rawContent.match(/主催・主管\s*([^\s]+)/) || [])[1] || null;

      if (titlePart && titlePart.length > 1 && !titlePart.includes("休館日")) {
        let eventYear = year;
        if (today.getMonth() === 11 && blocks[i].m === 1) eventYear++;
        const dateStr = `${eventYear}-${String(blocks[i].m).padStart(2, '0')}-${String(blocks[i].d).padStart(2, '0')}`;
        
        // --- template.json の定義順（全11項目）に厳密に一致 ---
        events.push({
          title: titlePart,
          date_from: dateStr,
          date_to: dateStr,
          time_start: null,
          time_end: null,
          description: venueName ? `会場: ${venueName}` : null,
          image_url: null,
          price: null,
          contact: organizer,
          source_url: TARGET_URL,
          tags: {
            type: "other",
            genres: [],
            flags: []
          }
        });
      }
    }

    const uniqueEvents = Array.from(new Map(
      events.map(e => [`${e.date_from}-${e.title}`, e])
    ).values());

    const resultData = {
      venue_id: VENUE_ID, // venue_id はルートのみ
      last_success_at: new Date().toISOString().split('T')[0],
      events: uniqueEvents
    };

    saveEventJson(OUTPUT_PATH, resultData);
    console.log(`[SUCCESS] JSON structure strictly follows template.json (venue_id is root-only).`);

  } catch (error) {
    console.error(`[FATAL] ${error.message}`);
    process.exit(1);
  }
}

main();
