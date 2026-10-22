"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "background.js"), "utf8");

function createWorker() {
  let now = Date.now();
  class ClockDate extends Date { static now() { return now; } }
  let messageHandler;
  let alarmHandler;
  let savedJobs = {};
  let createdTabs = 0;
  const alarms = new Map();
  const notifications = [];
  const tabs = new Map([
    [
      10,
      { id: 10, url: "https://chatgpt.com/c/first-chat", title: "Первый чат" },
    ],
    [
      20,
      {
        id: 20,
        url: "https://chatgpt.com/c/second-chat",
        title: "Второй чат",
      },
    ],
  ]);

  const chrome = {
    runtime: {
      id: "watchdog-test-id",
      getURL: (file) => "chrome-extension://watchdog-test-id/" + file,
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: {
        addListener(fn) {
          messageHandler = fn;
        },
      },
    },
    storage: {
      local: {
        async get() {
          return { jobs: structuredClone(savedJobs) };
        },
        async set(data) {
          savedJobs = structuredClone(data.jobs);
        },
      },
      onChanged: { addListener() {} },
    },
    alarms: {
      async get(name) {
        return alarms.get(name);
      },
      async create(name, options) { alarms.set(name, { ...options, scheduledTime: options.when }); },
      async clear(name) { alarms.delete(name); },
      onAlarm: {
        addListener(fn) {
          alarmHandler = fn;
        },
      },
    },
    tabs: {
      async get(id) {
        if (!tabs.has(id)) throw new Error("Нет вкладки");
        return tabs.get(id);
      },
      async sendMessage(tabId, message) {
        notifications.push({ tabId, ...message });
        return { ok: true };
      },
      async create() {
        createdTabs++;
        throw new Error("Создавать вкладки нельзя");
      },
    },
    scripting: {
      async executeScript() {
        return [];
      },
    },
  };

  vm.runInNewContext(source, {
    chrome,
    URL,
    crypto: webcrypto,
    console,
    Date: ClockDate,
    Promise,
  });

  const popup = {
    id: chrome.runtime.id,
    url: chrome.runtime.getURL("popup.html"),
  };
  const content = (id) => ({
    id: chrome.runtime.id,
    tab: { id },
    url: tabs.get(id)?.url || "https://evil.example/",
  });

  const message = (msg, sender = popup) =>
    new Promise((resolve) => {
      messageHandler(msg, sender, resolve);
    });
  const jobs = () => Object.values(savedJobs);
  const add = async (id) =>
    message({ type: "ADD", tabId: id, url: tabs.get(id).url });

  return {
    popup,
    content,
    message,
    jobs,
    add,
    tabs,
    alarms,
    notifications,
    advance(ms) { now += ms; },
    async alarm(name = "watchdog-lite") {
      alarmHandler({ name });
      await new Promise((resolve) => setImmediate(resolve));
    },
    get createdTabs() {
      return createdTabs;
    },
  };
}

test("запуск из окна расширения создаёт задание для открытого чата", async () => {
  const worker = createWorker();
  const added = await worker.add(10);
  assert.ok(added.job?.id);
  assert.equal(added.job.mode, "RUNNING");
  assert.equal(added.job.url, "https://chatgpt.com/c/first-chat");
  assert.equal(
    (await worker.message({ type: "GET" })).jobs[added.job.id].id,
    added.job.id,
  );
});

test("вкладка не видит задания других вкладок", async () => {
  const worker = createWorker();
  const first = (await worker.add(10)).job;
  const second = (await worker.add(20)).job;
  const response = await worker.message({ type: "GET" }, worker.content(10));
  assert.deepEqual(Object.keys(response.jobs), [first.id]);
  assert.equal(response.jobs[second.id], undefined);
});

test("скрипт страницы не может запускать и удалять задания", async () => {
  const worker = createWorker();
  const first = (await worker.add(10)).job;
  const attempt = await worker.message(
    { type: "REMOVE", id: first.id },
    worker.content(10),
  );
  assert.match(attempt.error, /окна расширения/);
  const other = await worker.message(
    { type: "ADD", tabId: 20, url: worker.tabs.get(20).url },
    worker.content(10),
  );
  assert.match(other.error, /окна расширения/);
  assert.equal(worker.jobs().length, 1);
});

test("подмена сайта и изменение постоянных полей отклоняются", async () => {
  const worker = createWorker();
  const first = (await worker.add(10)).job;
  const request = {
    type: "PATCH",
    id: first.id,
    runId: first.runId,
    expectedUrl: first.url,
    expectedPhase: first.phase,
    patch: { url: "https://attacker.example/" },
  };
  const rejected = await worker.message(request, worker.content(10));
  assert.match(rejected.error, /Недопустимое/);
  assert.equal(worker.jobs()[0].url, first.url);

  const outsider = await worker.message(
    { type: "GET" },
    {
      id: "watchdog-test-id",
      tab: { id: 10 },
      url: "https://attacker.example/",
    },
  );
  assert.match(outsider.error, /вкладке ChatGPT/);
});

test("перед обновлением проверяются адрес, этап и запуск", async () => {
  const worker = createWorker();
  const job = (await worker.add(10)).job;
  const message = {
    type: "PATCH",
    id: job.id,
    runId: job.runId,
    expectedUrl: job.url,
    expectedPhase: "WAIT",
    patch: { detail: "устаревшая запись" },
  };
  assert.equal((await worker.message(message, worker.content(10))).ok, false);
  assert.equal(worker.jobs()[0].detail, "Проверяю страницу");

  message.expectedPhase = "BOOT";
  message.runId = "unknown";
  assert.equal((await worker.message(message, worker.content(10))).ok, false);
});

test("поля состояния проверяются по типам и ограничениям", async () => {
  const worker = createWorker();
  const job = (await worker.add(10)).job;
  const patch = (value) =>
    worker.message(
      {
        type: "PATCH",
        id: job.id,
        runId: job.runId,
        expectedUrl: job.url,
        expectedPhase: "BOOT",
        patch: value,
      },
      worker.content(10),
    );

  assert.match((await patch({ turn: 101 })).error, /Недопустимое/);
  assert.match((await patch({ detail: "x".repeat(501) })).error, /Недопустимое/);
  assert.match((await patch({ tabId: 20 })).error, /Недопустимое/);
  assert.equal((await patch({ turn: 100 })).ok, true);
  assert.equal(worker.jobs()[0].turn, 100);
});

test("закрытая или переключённая вкладка не открывается заново", async () => {
  const worker = createWorker();
  await worker.add(10);
  worker.tabs.get(10).url = "https://chatgpt.com/c/different-chat";
  await worker.alarm();
  assert.equal(worker.jobs()[0].mode, "ERROR");
  assert.equal(worker.createdTabs, 0);
});

test("общая остановка доступна только из окна расширения", async () => {
  const worker = createWorker();
  await worker.add(10);
  const rejected = await worker.message(
    { type: "STOP_ALL" },
    worker.content(10),
  );
  assert.match(rejected.error, /окна расширения/);
  assert.equal(worker.jobs().length, 1);
  assert.equal((await worker.message({ type: "STOP_ALL" })).ok, true);
  assert.equal(worker.jobs().length, 0);
});

test("разрешения ограничены сайтом ChatGPT и нужными API", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*"]);
  assert.deepEqual(manifest.permissions, ["storage", "alarms", "scripting"]);
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "https://chatgpt.com/c/*",
    "https://chatgpt.com/g/*",
  ]);
});

test("число продолжений ограничено, перезагрузки нет", () => {
  const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
  assert.match(content, /maxTurns: 100/);
  assert.match(content, /j\.turn >= LIMIT\.maxTurns/);
  assert.doesNotMatch(content, /location\.reload\s*\(/);
});

test("повторный запуск заменяет завершённую запись и сбрасывает счётчики", async () => {
  const worker = createWorker();
  const first = (await worker.add(10)).job;
  const oldRun = first.runId;
  await worker.message({
    type: "PATCH", id: first.id, runId: oldRun,
    expectedUrl: first.url, expectedPhase: "BOOT",
    patch: { mode: "PAUSED", phase: "DONE", result: "PASS", turn: 42 },
  }, worker.content(10));

  const next = (await worker.add(10)).job;
  assert.equal(worker.jobs().length, 1);
  assert.notEqual(next.id, first.id);
  assert.notEqual(next.runId, oldRun);
  assert.equal(next.mode, "RUNNING");
  assert.equal(next.turn, 0);
  assert.equal(next.result, "");
  assert.equal((await worker.message({
    type: "PATCH", id: first.id, runId: oldRun,
    expectedUrl: first.url, expectedPhase: "DONE", patch: { detail: "старый запуск" },
  }, worker.content(10))).ok, false);
});

test("повторный запуск после ошибки не затрагивает соседний чат", async () => {
  const worker = createWorker();
  const first = (await worker.add(10)).job;
  const second = (await worker.add(20)).job;
  await worker.message({
    type: "PATCH", id: first.id, runId: first.runId,
    expectedUrl: first.url, expectedPhase: "BOOT",
    patch: { mode: "ERROR", error: "Нет ответа", turn: 4 },
  }, worker.content(10));
  const next = (await worker.add(10)).job;
  assert.equal(worker.jobs().length, 2);
  assert.equal(worker.jobs().find(job => job.id === second.id).runId, second.runId);
  assert.equal(next.error, "");
  assert.equal(next.turn, 0);
});

test("двойное нажатие запуска не создаёт второе задание", async () => {
  const worker = createWorker();
  const responses = await Promise.all([worker.add(10), worker.add(10)]);
  assert.equal(responses.filter(response => response.job).length, 1);
  assert.match(responses.find(response => response.error).error, /уже запущен/);
  assert.equal(worker.jobs().length, 1);
});

test("старая карточка не запускает другой чат в той же вкладке", async () => {
  const worker = createWorker();
  const first = (await worker.add(10)).job;
  worker.tabs.get(10).url = "https://chatgpt.com/c/different-chat";
  await worker.alarm();
  const response = await worker.message({ type: "ADD", tabId: 10, url: first.url });
  assert.match(response.error, /Откройте нужный чат/);
  assert.equal(worker.jobs()[0].mode, "ERROR");
  assert.equal(worker.jobs()[0].runId, first.runId);
});

test("главная страница и посторонний сайт не запускаются", async () => {
  const worker = createWorker();
  for (const url of ["https://chatgpt.com/", "https://example.com/c/chat"]) {
    worker.tabs.get(10).url = url;
    assert.ok((await worker.add(10)).error);
  }
  assert.equal(worker.jobs().length, 0);
});

test("после 20 работающих чатов новые задания не создаются", async () => {
  const worker = createWorker();
  for (let id = 100; id < 121; id++) {
    worker.tabs.set(id, { id, url: "https://chatgpt.com/c/chat-" + id });
    const result = await worker.add(id);
    if (id < 120) assert.ok(result.job);
    else assert.match(result.error, /20 чатов/);
  }
  assert.equal(worker.jobs().length, 20);
});

const update = (worker, job, patch) => worker.message({
  type: "PATCH", id: job.id, runId: job.runId,
  expectedUrl: job.url, expectedPhase: job.phase, patch,
}, worker.content(job.tabId));

test("срок запуска равен 15 минутам и не меняется из вкладки", async () => {
  const worker = createWorker();
  const job = (await worker.add(10)).job;
  assert.equal(job.deadline - job.startedAt, 15 * 60_000);
  assert.match((await update(worker, job, { deadline: job.deadline + 60_000 })).error, /Недопустимое/);
  assert.match((await update(worker, job, { startedAt: job.startedAt + 60_000 })).error, /Недопустимое/);
  assert.match((await update(worker, job, { result: "TIMEOUT" })).error, /Недопустимое/);
  await worker.alarm();
  assert.equal(worker.alarms.get("watchdog-deadline").scheduledTime, job.deadline);
});

test("PAUSE остаётся под наблюдением и WORKING не сбрасывает срок", async () => {
  const worker = createWorker();
  const job = (await worker.add(10)).job;
  const paused = (await update(worker, job, {
    mode: "PAUSED", phase: "PAUSE", result: "PAUSE", pauseUserCount: 0,
  })).job;
  assert.ok((await worker.message({ type: "GET" }, worker.content(10))).jobs[job.id]);
  assert.match((await worker.add(10)).error, /уже запущен/);
  worker.advance(5 * 60_000);
  const resumed = (await update(worker, paused, {
    mode: "RUNNING", phase: "SENDING", result: "", cmd: "cmd-resumed-12345678",
  })).job;
  assert.equal(resumed.deadline, job.deadline);
  assert.equal(resumed.startedAt, job.startedAt);
  assert.equal(resumed.endedAt, 0);
});

test("ровно на 15 минутах последняя проверка отправки отказывает", async () => {
  const worker = createWorker();
  const job = (await worker.add(10)).job;
  const cmd = "cmd-timeout-12345678";
  await update(worker, job, { phase: "SENDING", cmd });
  worker.advance(15 * 60_000 - 1);
  const check = { type: "CHECK", id: job.id, runId: job.runId, cmd };
  assert.equal((await worker.message(check, worker.content(10))).ok, true);
  worker.advance(1);
  const expired = await worker.message(check, worker.content(10));
  assert.equal(expired.ok, false);
  assert.equal(expired.expired, true);
  assert.equal(worker.jobs()[0].result, "TIMEOUT");
  assert.ok(worker.notifications.some(message => message.type === "TIMEOUT" && message.runId === job.runId));
});

test("пауза тоже заканчивается по общему сроку, старый запуск не оживает", async () => {
  const worker = createWorker();
  const job = (await worker.add(10)).job;
  const paused = (await update(worker, job, {
    mode: "PAUSED", phase: "PAUSE", result: "PAUSE",
  })).job;
  worker.advance(15 * 60_000);
  await worker.alarm("watchdog-deadline");
  assert.equal(worker.jobs()[0].result, "TIMEOUT");
  assert.equal(worker.jobs()[0].mode, "ERROR");
  assert.equal((await update(worker, paused, {
    mode: "RUNNING", phase: "WAIT", result: "",
  })).ok, false);
  assert.equal(worker.alarms.has("watchdog-deadline"), false);
});

test("после сна компьютера отправка блокируется до следующего фонового опроса", async () => {
  const worker = createWorker();
  const job = (await worker.add(10)).job;
  worker.advance(30 * 60_000);
  const response = await update(worker, job, { phase: "SENDING", cmd: "cmd-late-12345678" });
  assert.equal(response.expired, true);
  assert.equal(worker.jobs()[0].result, "TIMEOUT");
});

test("старый запуск без срока после обновления требует ручного перезапуска", async () => {
  const worker = createWorker();
  await worker.add(10);
  delete worker.jobs()[0].deadline;
  await worker.alarm();
  assert.equal(worker.jobs()[0].mode, "ERROR");
  assert.match(worker.jobs()[0].error, /После обновления/);
});
