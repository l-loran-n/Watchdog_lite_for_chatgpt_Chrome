"use strict";

const elements = {
  add: document.querySelector("#add"),
  stopAll: document.querySelector("#stop-all"),
  list: document.querySelector("#list"),
  heading: document.querySelector("#heading"),
  message: document.querySelector("#message"),
};

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

function stateLabel(job) {
  if (job.mode === "ERROR") return "Ошибка · остановлено";
  if (job.mode === "PAUSED") return "Завершено · " + (job.result || "пауза");
  if (job.detail?.includes("поле ввода")) return "Ожидание редактора";
  if (job.kind === "RESCUE") return "Восстановление ответа";
  if (job.attention) return "Внимание";
  return (
    {
      BOOT: "Подготовка",
      SENDING: "Отправка",
      WAIT: "Ожидание ответа",
    }[job.phase] || "В работе"
  );
}

function textElement(tag, className, value) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = String(value ?? "");
  return element;
}

function createJobCard(job) {
  const card = textElement("article", "job", "");
  const info = textElement("div", "job-info", "");
  info.append(textElement("div", "job-name", job.title || "Диалог ChatGPT"));

  const status = textElement("div", "job-status", "");
  const dot = textElement(
    "span",
    "status-dot" +
      (job.mode === "PAUSED" ? " done" : job.mode === "ERROR" ? " error" : ""),
    "",
  );
  dot.setAttribute("aria-hidden", "true");
  status.append(
    dot,
    document.createTextNode(stateLabel(job) + " · сообщений: " + job.turn),
  );
  info.append(status);
  info.append(textElement("div", "job-url", job.url));

  if (job.detail) info.append(textElement("div", "job-detail", job.detail));
  if (job.error || job.attention) {
    info.append(textElement("div", "job-error", job.attention || job.error));
  }

  const remove = textElement("button", "remove", "×");
  remove.type = "button";
  remove.title = "Остановить наблюдение за этим диалогом";
  remove.setAttribute("aria-label", "Остановить: " + (job.title || "диалог"));
  remove.addEventListener("click", async () => {
    remove.disabled = true;
    try {
      await request({ type: "REMOVE", id: job.id });
      await render();
    } catch (error) {
      elements.message.textContent = error.message;
      remove.disabled = false;
    }
  });

  card.append(info, remove);
  return card;
}

async function render() {
  const jobs = Object.values((await request({ type: "GET" })).jobs);
  elements.heading.textContent = "Диалоги (" + jobs.length + ")";
  elements.stopAll.disabled = jobs.length === 0;
  elements.list.replaceChildren();
  if (!jobs.length) {
    elements.list.append(
      textElement("div", "empty", "Нет отслеживаемых диалогов"),
    );
    return;
  }
  jobs.sort(
    (first, second) => (second.mode === "RUNNING") - (first.mode === "RUNNING"),
  );
  for (const job of jobs) elements.list.append(createJobCard(job));
}

elements.add.addEventListener("click", async () => {
  elements.add.disabled = true;
  elements.message.textContent = "";
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!tab?.url?.startsWith("https://chatgpt.com/")) {
      throw new Error("Сначала откройте существующий диалог на chatgpt.com.");
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    const page = new URL(tab.url);
    await request({
      type: "ADD",
      tabId: tab.id,
      url: page.origin + page.pathname.replace(/\/$/, ""),
    });
    await render();
  } catch (error) {
    elements.message.textContent = error.message || String(error);
  } finally {
    elements.add.disabled = false;
  }
});

elements.stopAll.addEventListener("click", async () => {
  if (!window.confirm("Остановить наблюдение за всеми диалогами?")) return;
  elements.stopAll.disabled = true;
  try {
    await request({ type: "STOP_ALL" });
    await render();
  } catch (error) {
    elements.message.textContent = error.message || String(error);
    elements.stopAll.disabled = false;
  }
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") render().catch(() => {});
});
render().catch((error) => {
  elements.message.textContent = error.message;
});
