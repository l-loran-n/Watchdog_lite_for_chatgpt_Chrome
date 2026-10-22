"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Минимальная страница с сообщениями. Код распознавания запускается без изменений.
function conversation(messages = [], pageText = "") {
  const nodes = messages.map(([role, text], index) => ({
    innerText: text,
    parentElement: { closest: () => null },
    matches: () => true,
    querySelector: () => null,
    getAttribute: () => role,
    compareDocumentPosition: other => index < nodes.indexOf(other) ? 4 : 2,
  }));
  const main = {
    innerText: pageText || messages.map(([, text]) => text).join("\n"),
    querySelectorAll: selector => selector.startsWith('[data-testid^="conversation-turn-"]') ? nodes : [],
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
  assert.ok(context.reader, "Код распознавания должен быть доступен тесту");
  return context.reader;
}

const cmd = "cmd-test-12345678";
const command = "[WATCHDOG LITE]\nCOMMAND_ID=" + cmd;
const line = state => "WD6_STATUS COMMAND_ID=" + cmd + " STATE=" + state;

test("принимается единственный статус в конце ответа с нужным ID", () => {
  const { status } = conversation();
  for (const state of ["PASS", "FAIL", "WORKING", "PAUSE"]) {
    assert.equal(status("Текст ответа\n" + line(state), cmd), state);
  }
  assert.equal(status("<WD_STATUS>VERSION=1 COMMAND_ID=" + cmd + " STATE=PASS</WD_STATUS>", cmd), "PASS");
});

test("чужой, повторный и незавершающий статус не принимается", () => {
  const { status } = conversation();
  assert.equal(status(line("PASS"), "cmd-other-12345678"), null);
  assert.equal(status(line("PASS") + "\n" + line("PASS"), cmd), null);
  assert.equal(status(line("PASS") + "\nНо ещё не всё готово", cmd), null);
  assert.equal(status("PASS", cmd), null);
});

test("результат берётся из ответа после команды, а не из цитаты пользователя", () => {
  const reader = conversation([
    ["user", command + "\n" + line("PASS")],
    ["assistant", "Работа ещё продолжается"],
  ]);
  const reply = reader.replyFor(cmd);
  assert.equal(reply.sent, true);
  assert.equal(reply.answer, "Работа ещё продолжается");
  assert.equal(reader.status(reply.answer, cmd), null);
});

test("строка статуса в неизвестной разметке подтверждает только наличие сообщения", () => {
  const reader = conversation([], command + "\n" + line("PASS"));
  const reply = reader.replyFor(cmd);
  assert.equal(reply.sent, true);
  assert.equal(reply.answer, "");
  assert.equal(reply.unreadable, true);
});

test("после нового сообщения пользователя старый ответ не считается актуальным", () => {
  const reader = conversation([
    ["user", command],
    ["assistant", line("WORKING")],
    ["user", "Стоп, я изменил задачу"],
  ]);
  assert.equal(reader.replyFor(cmd).userTurns, 1);
  assert.equal(reader.replyFor(cmd).answer, "");
});

test("корректный ответ ChatGPT распознаётся после нужной команды", () => {
  const reader = conversation([
    ["assistant", "Ответ на более ранний вопрос"],
    ["user", command],
    ["assistant", "Готово\n" + line("PASS")],
  ]);
  const reply = reader.replyFor(cmd);
  assert.equal(reply.sent, true);
  assert.equal(reader.status(reply.answer, cmd), "PASS");
});
