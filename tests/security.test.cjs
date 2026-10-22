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
  let messageHandler;
  let alarmHandler;
  let savedJobs = {};
  let createdTabs = 0;
  const tabs = new Map([
    [
      10,
      { id: 10, url: "https://chatgpt.com/c/first-chat", title: "First chat" },
    ],
    [
      20,
      {
        id: 20,
        url: "https://chatgpt.com/c/second-chat",
        title: "Second chat",
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
          return { jobs: savedJobs };
        },
        async set(data) {
          savedJobs = data.jobs;
        },
      },
      onChanged: { addListener() {} },
    },
    alarms: {
      async get() {
        return null;
      },
      async create() {},
      async clear() {},
      onAlarm: {
        addListener(fn) {
          alarmHandler = fn;
        },
      },
    },
    tabs: {
      async get(id) {
        if (!tabs.has(id)) throw new Error("No tab");
        return tabs.get(id);
      },
      async sendMessage() {
        return { ok: true };
      },
      async create() {
        createdTabs++;
        throw new Error("Tab creation is forbidden");
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
    Date,
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
    async alarm() {
      alarmHandler({ name: "watchdog-lite" });
      await new Promise((resolve) => setImmediate(resolve));
    },
    get createdTabs() {
      return createdTabs;
    },
  };
}

test("popup can create a job for an actual ChatGPT conversation", async () => {
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

test("content scripts cannot read jobs belonging to other tabs", async () => {
  const worker = createWorker();
  const first = (await worker.add(10)).job;
  const second = (await worker.add(20)).job;
  const response = await worker.message({ type: "GET" }, worker.content(10));
  assert.deepEqual(Object.keys(response.jobs), [first.id]);
  assert.equal(response.jobs[second.id], undefined);
});

test("site content cannot request new jobs or delete existing jobs", async () => {
  const worker = createWorker();
  const first = (await worker.add(10)).job;
  const attempt = await worker.message(
    { type: "REMOVE", id: first.id },
    worker.content(10),
  );
  assert.match(attempt.error, /popup/);
  const other = await worker.message(
    { type: "ADD", tabId: 20, url: worker.tabs.get(20).url },
    worker.content(10),
  );
  assert.match(other.error, /popup/);
  assert.equal(worker.jobs().length, 1);
});

test("rejects forged origin and disallows mutation of immutable identifiers", async () => {
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
  assert.match(rejected.error, /unsafe/);
  assert.equal(worker.jobs()[0].url, first.url);

  const outsider = await worker.message(
    { type: "GET" },
    {
      id: "watchdog-test-id",
      tab: { id: 10 },
      url: "https://attacker.example/",
    },
  );
  assert.match(outsider.error, /ChatGPT tab/);
});

test("checks URL, phase and runId before accepting a patch", async () => {
  const worker = createWorker();
  const job = (await worker.add(10)).job;
  const message = {
    type: "PATCH",
    id: job.id,
    runId: job.runId,
    expectedUrl: job.url,
    expectedPhase: "WAIT",
    patch: { detail: "stale write" },
  };
  assert.equal((await worker.message(message, worker.content(10))).ok, false);
  assert.equal(worker.jobs()[0].detail, "Запуск: проверка страницы");

  message.expectedPhase = "BOOT";
  message.runId = "unknown";
  assert.equal((await worker.message(message, worker.content(10))).ok, false);
});

test("enforces limits and type validation for patches", async () => {
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

  assert.match((await patch({ turn: 101 })).error, /unsafe/);
  assert.match((await patch({ detail: "x".repeat(501) })).error, /unsafe/);
  assert.match((await patch({ tabId: 20 })).error, /unsafe/);
  assert.equal((await patch({ turn: 100 })).ok, true);
  assert.equal(worker.jobs()[0].turn, 100);
});

test("does not reopen closed or navigated tabs", async () => {
  const worker = createWorker();
  await worker.add(10);
  worker.tabs.get(10).url = "https://chatgpt.com/c/different-chat";
  await worker.alarm();
  assert.equal(worker.jobs()[0].mode, "ERROR");
  assert.equal(worker.createdTabs, 0);
});

test("STOP_ALL requires popup and clears only extension jobs", async () => {
  const worker = createWorker();
  await worker.add(10);
  const rejected = await worker.message(
    { type: "STOP_ALL" },
    worker.content(10),
  );
  assert.match(rejected.error, /popup/);
  assert.equal(worker.jobs().length, 1);
  assert.equal((await worker.message({ type: "STOP_ALL" })).ok, true);
  assert.equal(worker.jobs().length, 0);
});

test("manifest restricts host to ChatGPT and uses minimal APIs", () => {
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

test("content script caps continuations and does not reload tabs", () => {
  const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
  assert.match(content, /maxTurns: 100/);
  assert.match(content, /j\.turn >= LIMIT\.maxTurns/);
  assert.doesNotMatch(content, /location\.reload\s*\(/);
});
