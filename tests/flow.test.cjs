"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const cmd = "cmd-flow-12345678";
const line = (state, id = cmd) => "WD6_STATUS COMMAND_ID=" + id + " STATE=" + state;

// Часы, поле ввода и история управляются тестом; tick и send — из самого расширения.
async function flow(state = "PAUSE") {
  let now = 1_800_000_000_000;
  let listener;
  let streaming = false;
  let stopClicks = 0;
  const sent = [];
  let saved = {
    id: "job", runId: "run", tabId: 10, url: "https://chatgpt.com/c/flow",
    mode: "RUNNING", phase: "WAIT", cmd, kind: "BOOT", turn: 1,
    startedAt: now, deadline: now + 15 * 60_000, seen: now, since: now,
    endedAt: 0, pauseUserCount: 0, result: "", repairs: 0, rescues: 0,
    recoveries: 0, anchor: "", ignoreError: false,
  };
  const messages = [
    ["user", "[WATCHDOG LITE]\nCOMMAND_ID=" + cmd],
    ["assistant", "Сделано: ничего\nПроверки: не запускались\nОсталось: нужен выбор\n" + line(state)],
  ];
  const box = () => ({ width: 400, height: 60 });
  class Textarea {
    constructor() { this._value = ""; this.isConnected = true; }
    get value() { return this._value; }
    set value(text) { this._value = text; }
    focus() {}
    dispatchEvent() {}
    getBoundingClientRect() { return box(); }
    matches(selector) { return selector.includes("textarea"); }
    closest(selector) { return selector === "form" ? { querySelector: () => sendButton } : null; }
  }
  const editor = new Textarea();
  const sendButton = {
    disabled: false,
    click() { sent.push(editor.value); messages.push(["user", editor.value]); editor.value = ""; },
  };
  const stopButton = {
    disabled: false, isConnected: true, closest: () => null, getBoundingClientRect: box,
    click() { stopClicks++; streaming = false; },
  };
  const main = {
    get innerText() { return messages.map(([, text]) => text).join("\n"); },
    querySelectorAll(selector) {
      if (!selector.startsWith('[data-testid^="conversation-turn-"]')) return [];
      const nodes = messages.map(([role, text], index) => ({
        innerText: text, matches: () => true, querySelector: () => null,
        parentElement: { closest: () => null }, getAttribute: () => role,
        compareDocumentPosition: other => index < nodes.indexOf(other) ? 4 : 2,
      }));
      return nodes;
    },
  };
  const chrome = {
    runtime: {
      id: "test",
      onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(message) {
        if (message.type === "IDENTIFY") return { tabId: 10 };
        if (message.type === "GET") return { jobs: { job: structuredClone(saved) } };
        if (message.type === "EXPIRE") {
          saved.mode = "ERROR"; saved.result = "TIMEOUT";
          return { ok: false, expired: true };
        }
        if (message.type === "CHECK") return { ok: now < saved.deadline };
        if (message.type === "PATCH") {
          assert.equal(message.expectedPhase, saved.phase);
          Object.assign(saved, structuredClone(message.patch));
          return { ok: true, job: structuredClone(saved) };
        }
        throw new Error("Неожиданная команда: " + message.type);
      },
    },
  };
  const context = {
    chrome,
    document: {
      querySelector: selector => selector === "main" ? main : null,
      querySelectorAll: selector => selector.includes("#prompt-textarea") ? [editor] :
        selector.includes('button[data-testid="stop-button"]') && streaming ? [stopButton] : [],
    },
    location: { origin: "https://chatgpt.com", pathname: "/c/flow" },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    HTMLTextAreaElement: Textarea, HTMLInputElement: Textarea, Event, crypto: webcrypto,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    Date: class extends Date { static now() { return now; } },
    setInterval() {}, setTimeout,
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  vm.runInNewContext(source.replace("  setInterval(tick, 1600);",
    "  globalThis.control = { tick, instruction };"), context);
  await new Promise(resolve => setImmediate(resolve));
  return {
    messages, sent, editor,
    get job() { return structuredClone(saved); },
    get stopClicks() { return stopClicks; },
    advance(ms) { now += ms; },
    streaming(value) { streaming = value; },
    tick: () => context.control.tick(),
    async settle() { await context.control.tick(); now += 7100; await context.control.tick(); },
    prompt: () => context.control.instruction("CONTINUE", cmd, saved),
    replaceJob(job) { saved = structuredClone(job); },
    async notify(message) {
      await new Promise(resolve => listener(message, { id: "test" }, resolve));
    },
  };
}

test("PAUSE прекращает сообщения и не снимается без ответа пользователя", async () => {
  const f = await flow();
  await f.settle();
  assert.equal(f.job.mode, "PAUSED");
  assert.equal(f.job.result, "PAUSE");
  f.messages[1][1] = line("WORKING");
  await f.settle();
  assert.equal(f.job.mode, "PAUSED");
  assert.equal(f.sent.length, 0);
});

test("после ответа пользователя новый WORKING автоматически продолжает запуск", async () => {
  const f = await flow();
  const deadline = f.job.deadline;
  await f.settle();
  f.messages.push(["user", "Выбираю первый вариант"], ["assistant", line("WORKING")]);
  await f.settle();
  assert.equal(f.job.mode, "RUNNING");
  assert.equal(f.job.phase, "WAIT");
  assert.equal(f.job.deadline, deadline);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /MESSAGE_KIND=CONTINUE/);
  assert.notEqual(f.job.cmd, cmd);
});

test("вмешательство пользователя во время WORKING включает паузу и ждёт свежий ответ", async () => {
  const f = await flow("WORKING");
  f.messages.push(["user", "Поправка к задаче"]);
  await f.tick();
  assert.equal(f.job.mode, "PAUSED");
  assert.equal(f.sent.length, 0);
  f.messages.push(["assistant", line("WORKING")]);
  await f.settle();
  assert.equal(f.job.mode, "RUNNING");
  assert.equal(f.sent.length, 1);
});

for (const state of ["PASS", "FAIL"]) {
  test("после паузы " + state + " завершает запуск без новой команды", async () => {
    const f = await flow();
    await f.settle();
    f.messages.push(["user", "Ответ на вопрос"], ["assistant", line(state)]);
    await f.settle();
    assert.equal(f.job.mode, "DONE");
    assert.equal(f.job.result, state);
    assert.equal(f.sent.length, 0);
  });
}

test("повторный PAUSE снова ждёт пользователя; чужой статус не снимает паузу", async () => {
  const f = await flow();
  await f.settle();
  f.messages.push(["user", "Уточнение"], ["assistant", line("PAUSE")]);
  await f.settle();
  assert.equal(f.job.pauseUserCount, 1);
  f.messages.push(["user", "Ещё уточнение"], ["assistant", line("WORKING", "cmd-foreign-12345678")]);
  await f.settle();
  assert.equal(f.job.result, "PAUSE");
  assert.equal(f.sent.length, 0);
});

test("черновик и незаконченная генерация не дают снять паузу отправкой", async () => {
  const f = await flow();
  await f.settle();
  f.messages.push(["user", "Мой ответ"], ["assistant", line("WORKING")]);
  f.streaming(true);
  await f.settle();
  assert.equal(f.sent.length, 0);
  f.streaming(false);
  f.editor.value = "Мой несохранённый текст";
  await f.settle();
  assert.equal(f.job.mode, "PAUSED");
  assert.equal(f.editor.value, "Мой несохранённый текст");
  assert.equal(f.sent.length, 0);
  f.editor.value = "";
  await f.tick();
  assert.equal(f.sent.length, 1);
});

test("истёкший срок не позволяет возобновиться по WORKING", async () => {
  const f = await flow();
  await f.settle();
  f.messages.push(["user", "Продолжай"], ["assistant", line("WORKING")]);
  f.advance(15 * 60_000);
  await f.settle();
  assert.equal(f.job.result, "TIMEOUT");
  assert.equal(f.sent.length, 0);
});

test("сигнал таймаута останавливает генерацию только своего истёкшего запуска", async () => {
  const f = await flow();
  const old = f.job;
  f.advance(15 * 60_000);
  f.streaming(true);
  f.replaceJob({ ...old, mode: "ERROR", result: "TIMEOUT" });
  await f.notify({ type: "TIMEOUT", id: "job", runId: "run" });
  assert.equal(f.stopClicks, 1);
  f.streaming(true);
  f.replaceJob({ ...old, runId: "new-run", deadline: old.deadline + 60_000 });
  await f.notify({ type: "TIMEOUT", id: "job", runId: "run" });
  assert.equal(f.stopClicks, 1);
});

test("промпт содержит остаток общего времени и требует фактические метрики", async () => {
  const f = await flow();
  assert.match(f.prompt(), /SECONDS_LEFT=900/);
  f.advance(5 * 60_000);
  const prompt = f.prompt();
  assert.match(prompt, /SECONDS_LEFT=600/);
  for (const text of ["PAUSE", "Сделано:", "Проверки:", "Осталось:", "Не придумывай числа"]) {
    assert.ok(prompt.includes(text));
  }
});
