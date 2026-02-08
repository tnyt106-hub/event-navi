// イベントのタイトルや価格などからタグを付与するためのスクリプト。
// ルールベースで説明可能にするため、判定ロジックは配列と正規表現で定義する。
// 使い方: node scripts/apply-event-tags.js docs/events/mimoca.json
// オプション: --overwrite (既存タグを上書きする)

const fs = require("fs");
const path = require("path");
const { validateFinalData } = require("./lib/schema");

// タグのラベル定義は JSON に集約して UI でも使えるようにしておく
const TAG_LABELS_PATH = path.join(__dirname, "..", "docs", "data", "event-tags.json");

const MAX_GENRES = 2;
const MAX_FLAGS = 2;
const NIGHT_START_MINUTES = 18 * 60;
const WEEKEND_CHECK_LIMIT_DAYS = 90;

const SPORTS_KEYWORDS = [
  "試合",
  "大会",
  "選手権",
  "マラソン",
  "駅伝",
  "サッカー",
  "野球",
  "バスケ",
  "バスケット",
  "バレーボール",
  "テニス",
  "ラグビー",
  "ゴルフ",
  "柔道",
  "剣道",
  "相撲",
  "陸上",
  "水泳",
  "トライアスロン",
  "スポーツ",
  "リーグ",
  "フットサル",
  "パブリックビューイング",
];

// 現在取得できているイベントの題名傾向（上映会・就職フェア・展示会など）に合わせて、
// タイプ判定に使う語彙をカテゴリごとに整理しておく。
const EXHIBITION_KEYWORDS = [
  "展覧会",
  "企画展",
  "特別展",
  "常設展",
  "展示",
  "コレクション展",
  "作品展",
  "写真展",
  "漆芸展",
];

const PERFORMANCE_KEYWORDS = [
  "公演",
  "ライブ",
  "コンサート",
  "演奏会",
  "舞台",
  "ミュージカル",
  "ステージ",
  "リサイタル",
  "吹奏楽",
  "オーケストラ",
  "歌謡祭",
  "dance",
  "演芸",
];

const WORKSHOP_KEYWORDS = [
  "ワークショップ",
  "体験",
  "教室",
  "つくろう",
  "作り",
  "づくり",
  "バックヤードツアー",
  "見学ツアー",
];

const LECTURE_KEYWORDS = [
  "講演",
  "講座",
  "セミナー",
  "トーク",
  "トークショー",
  "シンポジウム",
  "説明会",
  "カンファレンス",
  "商談会",
  "就職",
  "インターンシップ",
];

const FESTIVAL_KEYWORDS = ["祭", "フェス", "フェスティバル", "マルシェ", "市", "市場", "マーケット"];

const SCREENING_KEYWORDS = ["上映", "映画", "シネマ", "映画祭"];

const TYPE_RULES = [
  {
    key: "sports",
    patterns: SPORTS_KEYWORDS,
  },
  {
    key: "exhibition",
    patterns: EXHIBITION_KEYWORDS,
  },
  {
    key: "performance",
    patterns: PERFORMANCE_KEYWORDS,
  },
  {
    key: "screening",
    patterns: SCREENING_KEYWORDS,
  },
  {
    key: "workshop",
    patterns: WORKSHOP_KEYWORDS,
  },
  {
    key: "lecture",
    patterns: LECTURE_KEYWORDS,
  },
  {
    key: "business",
    patterns: ["フェア", "expo", "ショウ", "合同企業説明会", "キャリア", "ビジネス", "展示商談会"],
  },
  {
    key: "festival",
    patterns: FESTIVAL_KEYWORDS,
  },
  {
    key: "special_open",
    patterns: ["特別公開", "限定公開", "夜間開館", "延長開館", "特別開館"],
  },
  {
    key: "event",
    patterns: ["イベント", "催し", "催事"],
  },
];

const GENRE_RULES = [
  { key: "sports", patterns: SPORTS_KEYWORDS },
  { key: "art", patterns: ["美術", "アート", "展覧会", "企画展"] },
  { key: "history", patterns: ["歴史", "史跡", "文化財", "遺跡"] },
  { key: "culture", patterns: ["文化", "伝統", "工芸", "民芸"] },
  { key: "science", patterns: ["科学", "サイエンス", "技術", "プラネタリウム"] },
  { key: "music", patterns: ["音楽", "コンサート", "ライブ", "演奏"] },
  { key: "theater", patterns: ["演劇", "舞台", "ミュージカル", "映画", "上映"] },
  { key: "kids", patterns: ["子ども", "こども", "キッズ", "親子"] },
  { key: "local", patterns: ["地域", "地元", "まち", "商店街"] },
  { key: "food", patterns: ["グルメ", "食", "フード", "マルシェ", "市場", "物産"] },
  { key: "nature", patterns: ["自然", "公園", "山", "花", "海", "森"] },
  { key: "business", patterns: ["ビジネス", "キャリア", "就職", "インターンシップ", "商談"] },
];

const FLAG_RULES = [
  {
    key: "limited",
    patterns: ["限定", "先着", "抽選"],
  },
  {
    key: "free",
    patterns: ["無料", "free"],
  },
  {
    key: "paid",
    patterns: ["有料", "円", "料金"],
  },
  {
    key: "night",
    patterns: ["夜間", "ナイト", "夜"],
  },
  {
    key: "weekend",
    patterns: [],
  },
  {
    key: "family",
    patterns: ["親子", "ファミリー", "子ども", "こども", "キッズ"],
  },
  {
    key: "reservation_required",
    patterns: ["要予約", "予約制", "事前予約"],
  },
  {
    key: "sold_out",
    patterns: ["予定枚数終了", "完売", "soldout"],
  },
];

// 文字列を検索対象にしやすい形式に整える
function normalizeText(value) {
  if (!value) return "";
  return String(value).replace(/\s+/g, "").toLowerCase();
}

// パターン配列のうち、ひとつでも一致するかを判定する
function matchesAnyPattern(text, patterns) {
  if (!text || !patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) {
      return pattern.test(text);
    }
    return text.includes(String(pattern).toLowerCase());
  });
}

// 時刻文字列を「分」に変換する (例: "18:30" -> 1110)
function parseTimeToMinutes(timeText) {
  if (!timeText) return null;
  const match = String(timeText).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

// 開催期間内に週末が含まれるかを判定する
function parseDateAsUtc(dateText) {
  if (!dateText) return null;
  const [year, month, day] = String(dateText).split("-").map(Number);
  if (!year || !month || !day) return null;
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(utcDate.getTime())) return null;
  return utcDate;
}

function includesWeekend(dateFrom, dateTo) {
  const start = parseDateAsUtc(dateFrom);
  const end = parseDateAsUtc(dateTo ?? dateFrom);
  if (!start || !end) return false;

  const diffDays = Math.floor((end - start) / (1000 * 60 * 60 * 24));
  const safeDiffDays = Math.min(Math.max(diffDays, 0), WEEKEND_CHECK_LIMIT_DAYS);

  for (let i = 0; i <= safeDiffDays; i += 1) {
    const current = new Date(start);
    current.setUTCDate(start.getUTCDate() + i);
    const day = current.getUTCDay();
    if (day === 0 || day === 6) {
      return true;
    }
  }
  return false;
}

// タイプを優先順位で判定する（必ず 1 つ返す）
function determineType(text) {
  for (const rule of TYPE_RULES) {
    if (matchesAnyPattern(text, rule.patterns)) {
      return rule.key;
    }
  }
  return "other";
}

// ジャンルを最大2件まで抽出する
function determineGenres(text) {
  const genres = [];
  for (const rule of GENRE_RULES) {
    if (genres.length >= MAX_GENRES) break;
    if (matchesAnyPattern(text, rule.patterns)) {
      genres.push(rule.key);
    }
  }
  return genres;
}

// フラグを最大2件まで抽出する
function determineFlags(eventItem, combinedText) {
  const flags = [];
  const priceText = normalizeText(eventItem?.price);
  const startMinutes = parseTimeToMinutes(eventItem?.start_time);
  const endMinutes = parseTimeToMinutes(eventItem?.end_time);

  for (const rule of FLAG_RULES) {
    if (flags.length >= MAX_FLAGS) break;

    if (rule.key === "weekend") {
      if (includesWeekend(eventItem?.date_from, eventItem?.date_to)) {
        flags.push(rule.key);
      }
      continue;
    }

    if (rule.key === "night") {
      const hasNightKeyword = matchesAnyPattern(combinedText, rule.patterns);
      const isNightTime =
        (startMinutes !== null && startMinutes >= NIGHT_START_MINUTES) ||
        (endMinutes !== null && endMinutes >= NIGHT_START_MINUTES);
      if (hasNightKeyword || isNightTime) {
        flags.push(rule.key);
      }
      continue;
    }

    if (rule.key === "free" || rule.key === "paid") {
      if (matchesAnyPattern(priceText, rule.patterns)) {
        flags.push(rule.key);
      }
      continue;
    }

    if (matchesAnyPattern(combinedText, rule.patterns)) {
      flags.push(rule.key);
    }
  }

  return flags;
}

// 「上書きなし」のときに再計算不要なイベントか判定する
// ※要件の「tags.type が設定済みならスキップ」を明示的に維持する
function hasExistingTypeTag(eventItem) {
  return Boolean(eventItem?.tags && typeof eventItem.tags.type === "string" && eventItem.tags.type.trim());
}

// イベントにタグを付与する（既存タグは overwrite=true のときだけ上書き）
function applyTagsToEvent(eventItem, venueCategory, options) {
  if (!options.overwrite && hasExistingTypeTag(eventItem)) {
    return { updated: false, tags: eventItem.tags };
  }

  const combinedText = normalizeText(`${eventItem?.title ?? ""} ${venueCategory ?? ""}`);
  const type = determineType(combinedText);
  const genres = determineGenres(combinedText);
  const flags = determineFlags(eventItem, combinedText);

  const tags = { type, genres, flags };
  return { updated: true, tags };
}

// JSONファイルを安全に読み込む（空ファイル・壊れたJSONを検知）
function readJsonFileSafely(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  if (!raw.trim()) {
    throw new Error("ファイルが空です");
  }
  return JSON.parse(raw);
}

// ファイルを読み込み、タグ付けして保存する
function processEventsFile(filePath, options) {
  const data = readJsonFileSafely(filePath);
  const events = Array.isArray(data?.events) ? data.events : [];

  const venueCategory = data?.venue_category ?? null;
  let updatedCount = 0;

  events.forEach((eventItem) => {
    const result = applyTagsToEvent(eventItem, venueCategory, options);
    if (result.updated) {
      eventItem.tags = result.tags;
      updatedCount += 1;
    }
    if (options.log) {
      const tagInfo = result.tags
        ? `type=${result.tags.type}, genres=${result.tags.genres.join(",")}, flags=${result.tags.flags.join(",")}`
        : "tags=none";
      const status = result.updated ? "tagged" : "skipped";
      console.log(`[${status}] ${eventItem?.title ?? "イベント名未定"} -> ${tagInfo}`);
    }
  });

  // 保存前に最低限の整合性を検証し、壊れたJSONの上書きを予防する
  validateFinalData(events, { minEvents: 1 });

  if (!options.dryRun) {
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  }

  return updatedCount;
}

function loadTagLabels() {
  if (!fs.existsSync(TAG_LABELS_PATH)) return null;
  const raw = fs.readFileSync(TAG_LABELS_PATH, "utf-8");
  return JSON.parse(raw);
}

function resolveTargetPath(target) {
  // 絶対パス指定はそのまま使う
  if (path.isAbsolute(target)) return target;

  // 実行場所依存を避けるため、まず「スクリプト基準」で解決する
  const byScriptDir = path.join(__dirname, "..", target);
  if (fs.existsSync(byScriptDir)) {
    return byScriptDir;
  }

  // 後方互換として、従来どおり CWD 基準にもフォールバックする
  return path.resolve(process.cwd(), target);
}

function main() {
  const args = process.argv.slice(2);
  const overwrite = args.includes("--overwrite");
  const dryRun = args.includes("--dry-run");
  const target = args.find((arg) => !arg.startsWith("--"));

  if (!target) {
    console.log("Usage: node scripts/apply-event-tags.js <events.json> [--overwrite] [--dry-run]");
    process.exit(1);
  }

  const tagLabels = loadTagLabels();
  if (!tagLabels) {
    console.warn("タグラベル定義が見つかりませんでした。");
  }

  const filePath = resolveTargetPath(target);
  const fileName = path.basename(filePath);
  const options = { overwrite, dryRun, log: true };

  try {
    const updatedCount = processEventsFile(filePath, options);

    if (dryRun) {
      console.log(`dry-run: ${updatedCount} 件にタグを付与予定でした。`);
    } else {
      console.log(`完了: ${updatedCount} 件にタグを付与しました。`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ERROR] ${fileName}: ${message}`);
    process.exit(1);
  }
}

main();
