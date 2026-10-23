"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const cmd = "cmd-modern-12345678";
const command = "[WATCHDOG LITE]\nCOMMAND_ID=" + cmd;
const status = state => "WD6_STATUS COMMAND_ID=" + cmd + " STATE=" + state;

// Имитация DOM ChatGPT 2026: нет data-message-author-role; вместо него
// используются data-user-message-bubble и data-markdown-text-style.
function modernConversation(messages, wrappers = true) {
  const bodies = [];
  const turns = messages.map(([role, text], index) => {
    const marker = role === "user"
      ? "[data-user-message-bubble]"
      : "[data-markdown-text-style]";
    const body = {
      innerText: text,
      parentElement: { closest: () => null },
      matches: selector => selector.includes(marker),
      getAttribute: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
    };
    bodies.push(body);
    return {
      innerText: role === "assistant"
        ? "ChatGPT сказал:\n" + text + "\nКопировать"
        : "Вы сказали:\n" + text,
      parentElement: { closest: () => null },
      matches: () => false,
      getAttribute: () => null,
      querySelector: selector => selector.includes(marker) ? body : null,
      querySelectorAll: selector => selector.includes(marker) ? [body] : [],
      contains: node => node === body,
      compareDocumentPosition: other =>
        index < turns.indexOf(other) ? 4 : 2,
    };
  });
  bodies.forEach((body, index) => {
    body.compareDocumentPosition = other =>
      index < bodies.indexOf(other) ? 4 : 2;
  });
  const main = {
    innerText: messages.map(([, text]) => text).join("\n"),
    querySelectorAll: selector =>
      selector.startsWith('[data-testid^="conversation-turn-"]')
        ? (wrappers ? turns : [])
        : bodies,
  };
  const context = {
    chrome: { runtime: {
      sendMessage: async () => ({}),
      onMessage: { addListener() {} },
    } },
    document: { querySelector: selector => selector === "main" ? main : null },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    setInterval() {},
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  vm.runInNewContext(source.replace(
    "  setInterval(tick, 1600);",
    "  globalThis.reader = { status, replyFor };",
  ), context);
  return context.reader;
}

test("новый DOM: находит команду пользователя и ответ ChatGPT без меток роли", () => {
  const reader = modernConversation([
    ["user", command],
    ["assistant", "Готово\n" + status("PASS")],
  ]);
  const reply = reader.replyFor(cmd);
  assert.equal(reply.sent, true);
  assert.equal(reply.answer, "Готово\n" + status("PASS"));
  assert.equal(reader.status(reply.answer, cmd), "PASS");
});

test("служебные подписи контейнера не подменяют содержимое ответа", () => {
  const reader = modernConversation([
    ["user", command],
    ["assistant", "Проверки закончены\n" + status("WORKING")],
  ]);
  const reply = reader.replyFor(cmd);
  assert.ok(!reply.answer.includes("ChatGPT сказал"));
  assert.ok(!reply.answer.includes("Копировать"));
  assert.equal(reader.status(reply.answer, cmd), "WORKING");
});

test("новый DOM без контейнеров conversation-turn тоже распознаётся", () => {
  const reader = modernConversation([
    ["user", command],
    ["assistant", status("PAUSE")],
  ], false);
  const reply = reader.replyFor(cmd);
  assert.equal(reply.sent, true);
  assert.equal(reply.answer, status("PAUSE"));
});

test("статус из сообщения пользователя не принимается за ответ", () => {
  const reader = modernConversation([
    ["user", command + "\n" + status("PASS")],
    ["assistant", "Задача ещё идёт"],
  ]);
  assert.equal(reader.status(reader.replyFor(cmd).answer, cmd), null);
});

test("новый ответ после пользовательского уточнения вытесняет старый", () => {
  const reader = modernConversation([
    ["user", command],
    ["assistant", status("WORKING")],
    ["user", "Остановись и уточни"],
    ["assistant", status("PAUSE")],
  ]);
  const reply = reader.replyFor(cmd);
  assert.equal(reply.userTurns, 1);
  assert.equal(reader.status(reply.answer, cmd), "PAUSE");
});
