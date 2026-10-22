"use strict";

const elements = {
  add: document.querySelector("#add"),
  stopAll: document.querySelector("#stop-all"),
  list: document.querySelector("#list"),
  heading: document.querySelector("#heading"),
  message: document.querySelector("#message"),
};
document.querySelector("#version").textContent =
  "Для ChatGPT · " + chrome.runtime.getManifest().version;

async function request(message) {
  let response;
  try {
    response = await chrome.runtime.sendMessage(message);
  } catch {
    throw new Error("Не удалось связаться с расширением. Закройте это окно и откройте снова.");
  }
  if (!response) throw new Error("Расширение не ответило. Откройте это окно снова.");
  if (response.error) throw new Error(response.error);
  return response;
}

function stateLabel(job) {
  if (job.result === "TIMEOUT") return "Лимит 15 минут";
  if (job.mode === "ERROR") return "Остановлено";
  if (job.result === "PAUSE") return "Пауза · нужен ваш ответ";
  if (job.mode === "DONE" || job.mode === "PAUSED") {
    return { PASS: "Готово", FAIL: "Не удалось завершить" }[job.result] || "На паузе";
  }
  if (job.detail?.includes("черновик")) return "В поле ввода есть черновик";
  if (job.kind === "RESCUE") return "Пробую продолжить после ошибки";
  return {
    BOOT: "Подготовка",
    SENDING: "Отправляю сообщение",
    WAIT: "Жду ответ",
  }[job.phase] || "В работе";
}

const watching = job => job.mode === "RUNNING" ||
  (job.mode === "PAUSED" && job.result === "PAUSE");
function elapsedLabel(job) {
  if (!job.startedAt || !job.deadline) return "";
  const end = Math.min(job.endedAt || Date.now(), job.deadline);
  const seconds = Math.max(0, Math.floor((end - job.startedAt) / 1000));
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0") + " из 15:00";
}

function textElement(tag, className, value) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = String(value ?? "");
  return element;
}

async function startTab(tabId, expectedUrl) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || new URL(tab.url || "https://invalid.local").origin !== "https://chatgpt.com") {
    throw new Error("Откройте нужный чат на chatgpt.com и нажмите «Запустить в этом чате».");
  }
  // Для повторного запуска нужна именно та переписка, которая была в карточке.
  const page = new URL(tab.url);
  const currentUrl = page.origin + page.pathname.replace(/\/$/, "");
  if (expectedUrl && currentUrl !== expectedUrl) {
    throw new Error("В этой вкладке уже другой чат. Откройте нужный и запустите его снова.");
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch {
    throw new Error("Не удалось подключиться к чату. Перезагрузите вкладку и попробуйте снова.");
  }
  await request({ type: "ADD", tabId, url: currentUrl });
}

const pending = new Set();
function createJobCard(job) {
  const card = textElement("article", "job", "");
  const info = textElement("div", "job-info", "");
  const name = textElement("div", "job-name", job.title || "Чат ChatGPT");
  name.title = job.url;
  info.append(name);

  const status = textElement("div", "job-status", "");
  const failed = job.mode === "ERROR" || job.result === "FAIL";
  const dot = textElement("span", "status-dot" +
    (failed ? " error" : job.result === "PAUSE" ? " paused" :
      !watching(job) ? " done" : ""), "");
  dot.setAttribute("aria-hidden", "true");
  status.append(dot, document.createTextNode(stateLabel(job)));
  info.append(status);
  info.append(textElement("div", "job-detail", "Сообщений: " + (job.turn || 0) + " из 100"));
  if (elapsedLabel(job)) info.append(textElement("div", "job-detail", "Время: " + elapsedLabel(job)));

  if (job.detail && !job.error && !job.attention) {
    info.append(textElement("div", "job-detail", job.detail));
  }
  if (job.error || job.attention) {
    info.append(textElement("div", "job-error", job.error || job.attention));
  }

  if (!watching(job)) {
    const restart = textElement("button", "restart", "Запустить снова");
    restart.type = "button";
    restart.disabled = pending.has(job.id);
    restart.addEventListener("click", async () => {
      pending.add(job.id);
      restart.disabled = true;
      elements.message.textContent = "";
      try {
        await startTab(job.tabId, job.url);
        await render();
      } catch (error) {
        elements.message.textContent = error.message;
      } finally {
        pending.delete(job.id);
        restart.disabled = false;
      }
    });
    info.append(restart);
  }

  const remove = textElement("button", "remove", "×");
  remove.type = "button";
  remove.title = watching(job) ? "Остановить и убрать из списка" : "Убрать из списка";
  remove.setAttribute("aria-label", remove.title + ": " + (job.title || "чат"));
  remove.addEventListener("click", async () => {
    remove.disabled = true;
    elements.message.textContent = "";
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

let renderId = 0;
async function render() {
  const current = ++renderId;
  const jobs = Object.values((await request({ type: "GET" })).jobs || {});
  if (current !== renderId) return;
  elements.heading.textContent = "Чаты (" + jobs.length + ")";
  elements.stopAll.disabled = jobs.length === 0;
  elements.list.replaceChildren();
  if (!jobs.length) {
    elements.list.append(textElement("div", "empty",
      "Пока здесь пусто. Откройте чат с задачей и нажмите кнопку запуска."));
    return;
  }
  jobs.sort((first, second) => Number(watching(second)) - Number(watching(first)));
  for (const job of jobs) elements.list.append(createJobCard(job));
}

elements.add.addEventListener("click", async () => {
  elements.add.disabled = true;
  elements.message.textContent = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await startTab(tab?.id);
    await render();
  } catch (error) {
    elements.message.textContent = error.message;
  } finally {
    elements.add.disabled = false;
  }
});

elements.stopAll.addEventListener("click", async () => {
  if (!window.confirm("Остановить все чаты и очистить список? Уже отправленные сообщения останутся в ChatGPT.")) return;
  elements.stopAll.disabled = true;
  elements.message.textContent = "";
  try {
    await request({ type: "STOP_ALL" });
    await render();
  } catch (error) {
    elements.message.textContent = error.message;
    elements.stopAll.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.jobs) {
    render().catch((error) => { elements.message.textContent = error.message; });
  }
});
render().catch((error) => { elements.message.textContent = error.message; });
