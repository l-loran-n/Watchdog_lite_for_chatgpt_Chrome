"use strict";

// Состояние диалогов меняется только здесь: так вкладки не мешают друг другу.
const ALARM_NAME = "watchdog-lite";
const DEADLINE_ALARM = "watchdog-deadline";
const CHATGPT_ORIGIN = "https://chatgpt.com";
const MAX_JOBS = 20;
const MAX_TURNS = 100;
const RUN_TIME = 15 * 60_000;
const watching = (job) => job?.mode === "RUNNING" ||
  (job?.mode === "PAUSED" && job.result === "PAUSE");
const ALLOWED_PATCH_FIELDS = {
  mode: (value) => ["RUNNING", "ERROR", "PAUSED", "DONE"].includes(value),
  phase: (value) => ["BOOT", "SENDING", "WAIT", "PAUSE", "DONE"].includes(value),
  kind: (value) => ["", "BOOT", "CONTINUE", "REPAIR", "RESCUE"].includes(value),
  cmd: (value) =>
    typeof value === "string" &&
    (value === "" || /^cmd-[a-zA-Z0-9-]{8,80}$/.test(value)),
  turn: (value) => Number.isInteger(value) && value >= 0 && value <= MAX_TURNS,
  since: isTime,
  seen: isTime,
  recoveries: smallCounter,
  repairs: smallCounter,
  rescues: smallCounter,
  anchor: (value) => shortText(value, 128),
  ignoreError: (value) => typeof value === "boolean",
  detail: (value) => shortText(value, 500),
  result: (value) => ["", "PASS", "FAIL", "PAUSE"].includes(value),
  pauseUserCount: (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100_000,
  error: (value) => shortText(value, 500),
  attention: (value) => shortText(value, 500),
};

function isTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function smallCounter(value) {
  return Number.isInteger(value) && value >= 0 && value <= 10;
}
function shortText(value, max) {
  return typeof value === "string" && value.length <= max;
}
function normalizedUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.origin !== CHATGPT_ORIGIN || parsed.username || parsed.password)
      return "";
    return parsed.origin + parsed.pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}
function target(raw) {
  const url = normalizedUrl(raw);
  if (!url) return null;

  const path = new URL(url).pathname.split("/").filter(Boolean);
  const chatId = /^[\w-]+$/;
  const gptId = /^g-[\w-]+$/;

  if (path.length === 2 && path[0] === "c" && chatId.test(path[1])) {
    return { url, tabOnly: false };
  }
  if (
    path.length === 4 &&
    path[0] === "g" &&
    gptId.test(path[1]) &&
    path[2] === "c" &&
    chatId.test(path[3])
  ) {
    return { url, tabOnly: false };
  }
  if (path.length === 2 && path[0] === "g" && gptId.test(path[1])) {
    return { url, tabOnly: true };
  }
  return null;
}
function isPopup(sender) {
  return (
    sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL("popup.html")
  );
}
function isContent(sender) {
  return (
    sender.id === chrome.runtime.id &&
    Number.isInteger(sender.tab?.id) &&
    normalizedUrl(sender.url) !== ""
  );
}
function requirePopup(sender) {
  if (!isPopup(sender))
    throw new Error("Эта команда доступна только из окна расширения.");
}
function requireContent(sender) {
  if (!isContent(sender))
    throw new Error("Эта команда доступна только во вкладке ChatGPT.");
}

let queue = Promise.resolve();
function serialize(operation) {
  const task = queue.then(operation, operation);
  queue = task.catch(() => {});
  return task;
}

async function loadJobs() {
  const { jobs } = await chrome.storage.local.get("jobs");
  return jobs && typeof jobs === "object" && !Array.isArray(jobs) ? jobs : {};
}
const saveJobs = (jobs) => chrome.storage.local.set({ jobs });

function expired(job) {
  return !isTime(job.deadline) || Date.now() >= job.deadline;
}
function timeout(job) {
  Object.assign(job, {
    mode: "ERROR", phase: "DONE", result: "TIMEOUT", endedAt: Date.now(),
    error: isTime(job.deadline)
      ? "Лимит 15 минут исчерпан. Проверьте результат; новый запуск возможен вручную."
      : "После обновления расширения запустите этот чат заново.",
    detail: "", attention: "",
  });
}
async function notifyTimeout(job) {
  await chrome.tabs.sendMessage(job.tabId, {
    type: "TIMEOUT", id: job.id, runId: job.runId,
  }).catch(() => {});
}

async function armAlarm() {
  const jobs = await loadJobs();
  const active = Object.values(jobs).filter(watching);
  if (active.length) {
    if (!(await chrome.alarms.get(ALARM_NAME))) {
      await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
    }
    const when = Math.min(...active.map(job => job.deadline || Date.now()));
    if ((await chrome.alarms.get(DEADLINE_ALARM))?.scheduledTime !== when) {
      await chrome.alarms.create(DEADLINE_ALARM, { when });
    }
  } else {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.clear(DEADLINE_ALARM);
  }
}
chrome.runtime.onInstalled.addListener(() => {
  sweep().catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  sweep().catch(console.error);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.jobs) armAlarm().catch(console.error);
});
sweep().catch(console.error);

function validatePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Не удалось обновить состояние диалога.");
  }
  const entries = Object.entries(patch);
  if (entries.length === 0 || entries.length > 16)
    throw new Error("Некорректный размер обновления.");
  for (const [field, value] of entries) {
    if (
      !Object.hasOwn(ALLOWED_PATCH_FIELDS, field) ||
      !ALLOWED_PATCH_FIELDS[field](value)
    ) {
      throw new Error("Недопустимое изменение состояния диалога.");
    }
  }
  return patch;
}

async function handle(message, sender) {
  if (!message || typeof message.type !== "string")
    throw new Error("Неизвестная команда расширения.");
  if (message.type === "IDENTIFY") {
    requireContent(sender);
    return { tabId: sender.tab.id };
  }
  if (message.type === "GET") {
    if (isPopup(sender)) return { jobs: await loadJobs() };
    requireContent(sender);
    const jobs = await loadJobs();
    return {
      jobs: Object.fromEntries(
        Object.entries(jobs).filter(
          ([, job]) => job?.tabId === sender.tab.id,
        ),
      ),
    };
  }

  return serialize(async () => {
    const jobs = await loadJobs();

    if (message.type === "ADD") {
      requirePopup(sender);
      if (!Number.isInteger(message.tabId)) throw new Error("Вкладка не найдена.");
      const tab = await chrome.tabs.get(message.tabId).catch(() => null);
      const selected = target(tab?.url);
      if (!tab || !selected || selected.url !== normalizedUrl(message.url)) {
        throw new Error("Откройте нужный чат ChatGPT и попробуйте снова.");
      }
      if (
        Object.values(jobs).filter(watching).length >=
        MAX_JOBS
      ) {
        throw new Error("Уже запущено 20 чатов. Сначала остановите один из них.");
      }
      if (
        Object.values(jobs).some(
          (job) => watching(job) &&
            (job.tabId === tab.id || job.url === selected.url),
        )
      ) {
        throw new Error("Этот чат уже запущен.");
      }
      // При повторном запуске заменяем старую запись, а не копим карточки.
      for (const [id, job] of Object.entries(jobs)) {
        if (job?.tabId === tab.id || job?.url === selected.url) delete jobs[id];
      }
      const id = crypto.randomUUID();
      const startedAt = Date.now();
      jobs[id] = {
        id,
        runId: crypto.randomUUID(),
        tabId: tab.id,
        url: selected.url,
        tabOnly: selected.tabOnly,
        mode: "RUNNING",
        phase: "BOOT",
        cmd: "",
        kind: "",
        turn: 0,
        startedAt,
        deadline: startedAt + RUN_TIME,
        endedAt: 0,
        pauseUserCount: 0,
        since: startedAt,
        seen: startedAt,
        recoveries: 0,
        repairs: 0,
        anchor: "",
        rescues: 0,
        ignoreError: false,
        detail: "Проверяю страницу",
        result: "",
        error: "",
        attention: "",
        title: (tab.title || "Диалог ChatGPT").slice(0, 90),
      };
      await saveJobs(jobs);
      return { job: jobs[id] };
    }

    if (message.type === "STOP_ALL") {
      requirePopup(sender);
      await saveJobs({});
      return { ok: true };
    }

    if (message.type === "REMOVE") {
      requirePopup(sender);
      if (typeof message.id !== "string") throw new Error("Диалог не найден.");
      delete jobs[message.id];
      await saveJobs(jobs);
      return { ok: true };
    }

    requireContent(sender);
    const job = jobs[message.id];
    if (
      !job ||
      job.runId !== message.runId ||
      !watching(job) ||
      job.tabId !== sender.tab.id
    )
      return { ok: false };

    const tab = await chrome.tabs.get(job.tabId).catch(() => null);
    // Срок не меняется ни при паузе, ни при перезагрузке, ни при смене команды.
    if (expired(job)) {
      timeout(job);
      await saveJobs(jobs);
      await notifyTimeout(job);
      return { ok: false, expired: true };
    }
    if (message.type === "EXPIRE") return { ok: false };
    if (message.type === "CHECK") {
      return {
        ok:
          job.mode === "RUNNING" &&
          job.cmd === message.cmd &&
          job.phase === "SENDING" &&
          normalizedUrl(tab?.url) === job.url,
      };
    }

    if (message.type === "UPGRADE") {
      const next = normalizedUrl(tab?.url);
      if (
        !job.tabOnly ||
        !job.anchor ||
        message.anchor !== job.anchor ||
        !next.startsWith(job.url + "/c/") ||
        !target(next) ||
        target(next).tabOnly
      ) {
        return { ok: false };
      }
      job.url = next;
      job.tabOnly = false;
      job.seen = Date.now();
    } else if (message.type === "PATCH") {
      if (
        normalizedUrl(tab?.url) !== job.url ||
        job.url !== message.expectedUrl ||
        job.phase !== message.expectedPhase
      )
        return { ok: false };
      const patch = validatePatch(message.patch);
      Object.assign(job, patch);
      if (!watching(job)) job.endedAt = Date.now();
    } else {
      return { ok: false };
    }

    await saveJobs(jobs);
    return { ok: true, job };
  });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender)
    .then(reply)
    .catch((error) => reply({ error: String(error.message || error) }));
  return true;
});

function sweep() {
  return serialize(async () => {
    const jobs = await loadJobs();
    let changed = false;
    const timedOut = [];

    for (const job of Object.values(jobs)) {
      if (!watching(job)) continue;
      if (expired(job)) {
        timeout(job);
        timedOut.push(job);
        changed = true;
        continue;
      }
      const tab = await chrome.tabs.get(job.tabId).catch(() => null);
      const current = normalizedUrl(tab?.url);

      if (
        job.tabOnly &&
        current !== job.url &&
        current.startsWith(job.url + "/c/") &&
        target(current)
      ) {
        // Перед сменой адреса скрипт во вкладке должен сверить историю GPT.
        continue;
      }
      if (current !== job.url) {
        Object.assign(job, {
          mode: "ERROR",
          endedAt: Date.now(),
          error:
            "Вкладка закрыта или в ней открыт другой чат. Откройте нужный чат и запустите Watchdog снова.",
        });
        changed = true;
        continue;
      }
      if (Date.now() - (job.seen || 0) < 90_000) continue;

      const ping = await chrome.tabs
        .sendMessage(tab.id, { type: "PING" })
        .catch(() => null);
      if (ping?.ok) {
        job.seen = Date.now();
        job.recoveries = 0;
      } else {
        const injected = await chrome.scripting
          .executeScript({
            target: { tabId: tab.id },
            files: ["content.js"],
          })
          .then(() => true)
          .catch(() => false);
        job.recoveries = (job.recoveries || 0) + 1;
        if (!injected || job.recoveries >= 3) {
          Object.assign(job, {
            mode: "ERROR",
            endedAt: Date.now(),
            error:
              "Скрипт недоступен. Перезагрузите страницу вручную и добавьте диалог снова.",
          });
        } else {
          job.seen = Date.now();
        }
      }
      changed = true;
    }

    if (changed) await saveJobs(jobs);
    for (const job of timedOut) await notifyTimeout(job);
    await armAlarm();
  });
}
chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === ALARM_NAME || name === DEADLINE_ALARM) sweep().catch(console.error);
});
