const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

// 固定秒数スリープするためのユーティリティです。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 子プロセスとして Node.js で指定スクリプトを実行します。
// stdout/stderr を親プロセスへそのまま流し、終了コードを返します。
const runTask = (scriptPath, taskId) =>
  new Promise((resolve) => {
    const child = spawn('node', [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
    });

    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
    });

    child.on('error', (error) => {
      console.error(`[run-all] failed to start ${taskId}:`, error);
      resolve(1);
    });

    child.on('close', (code) => {
      // code が null の場合は異常終了として 1 扱いにします。
      resolve(code ?? 1);
    });
  });

const formatDuration = (ms) => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return `${minutes}m ${remainSeconds}s`;
};

const main = async () => {
  const startTime = Date.now();
  const configPath = path.resolve(__dirname, 'run-all.config.json');
  const repoRoot = path.resolve(__dirname, '..');

  // 設定ファイルを読み込み、enabled=true の task のみ順に実行します。
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const sleepSecondsBetween = Number(config.sleepSecondsBetween ?? 0);
  const tasks = (config.tasks ?? []).filter((task) => task.enabled);

  let executedCount = 0;
  let successCount = 0;
  const failedTaskIds = [];

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const scriptPath = path.resolve(repoRoot, task.script);

    console.log(`[run-all] start ${task.id}`);
    const exitCode = await runTask(scriptPath, task.id);
    executedCount += 1;

    if (exitCode === 0) {
      successCount += 1;
      console.log(`[run-all] success ${task.id}`);
    } else {
      failedTaskIds.push(task.id);
      console.log(`[run-all] failed ${task.id} (exit=${exitCode})`);
    }

    // 最後の task 以外はスリープして次の施設に移ります。
    if (index < tasks.length - 1 && sleepSecondsBetween > 0) {
      console.log(`[run-all] sleep ${sleepSecondsBetween}s before next task`);
      await sleep(sleepSecondsBetween * 1000);
    }
  }

  const failedCount = failedTaskIds.length;
  const totalDuration = Date.now() - startTime;

  console.log('[run-all] summary');
  console.log(`  executed: ${executedCount}`);
  console.log(`  success: ${successCount}`);
  console.log(`  failed: ${failedCount}`);
  if (failedCount > 0) {
    console.log(`  failedTaskIds: ${failedTaskIds.join(', ')}`);
  }
  console.log(`  duration: ${formatDuration(totalDuration)}`);

  // 失敗が1件でもあれば終了コードを 1 にします。
  process.exitCode = failedCount > 0 ? 1 : 0;
};

main().catch((error) => {
  console.error('[run-all] unexpected error:', error);
  process.exitCode = 1;
});
