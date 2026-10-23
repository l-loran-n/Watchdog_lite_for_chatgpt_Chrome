(() => {
  if (globalThis.__watchdogLite) return;
  globalThis.__watchdogLite = true;

  const LIMIT = {
    stable: 7000,
    send: 60000,
    history: 60000,
    page: 120000,
    repair: 2,
    rescue: 2,
    rescueWait: 90000,
    maxTurns: 100,
  };
  const $ = (q) => document.querySelector(q);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const read = (n) => (n?.innerText || n?.textContent || "").trim();
  const url = () => location.origin + location.pathname.replace(/\/$/, "");
  const rpc = (m) => chrome.runtime.sendMessage(m);
  // ChatGPT иногда оставляет в DOM скрытый старый editor и текст подсказки.
  // Работать можно только с действительно видимым полем ввода.
  function visible(el) {
    if (
      !el?.isConnected ||
      el.closest('[hidden], [inert], [aria-hidden="true"]')
    )
      return false;
    const r = el.getBoundingClientRect(),
      css = getComputedStyle(el);
    return (
      r.width > 4 &&
      r.height > 4 &&
      css.display !== "none" &&
      css.visibility !== "hidden" &&
      css.opacity !== "0"
    );
  }
  const composer = () =>
    [
      ...document.querySelectorAll(
        '#prompt-textarea, textarea[name="prompt-textarea"], div.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]',
      ),
    ]
      .filter(visible)
      .at(-1) || null;
  const clean = (text) =>
    (text || "")
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/\u00a0/g, " ")
      .trim();
  const sameText = (a, b) =>
    clean(a).replace(/\s+/g, "") === clean(b).replace(/\s+/g, "");
  function draftText(el) {
    if (!el) return "";
    if (el.matches("textarea, input")) return clean(el.value);
    // Только настоящие текстовые узлы. Плейсхолдеры, служебные и скрытые
    // дочерние узлы не являются пользовательским черновиком.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let text = "",
      node;
    while ((node = walker.nextNode())) {
      let hidden = false;
      for (let p = node.parentElement; p && p !== el; p = p.parentElement) {
        const placeholder = p.getAttribute("data-placeholder");
        if (
          p.matches(
            '[hidden], [aria-hidden="true"], [contenteditable="false"]',
          ) ||
          (placeholder && clean(p.textContent) === clean(placeholder)) ||
          (p.matches('[data-testid*="placeholder"]') &&
            !clean(p.textContent)) ||
          !visible(p)
        ) {
          hidden = true;
          break;
        }
      }
      if (!hidden) text += node.nodeValue;
    }
    return clean(text);
  }
  const stopButton = () => [...document.querySelectorAll(
    'button[data-testid="stop-button"], button[data-testid="stop-generating-button"], button[aria-label*="Stop generating"], button[aria-label*="Stop streaming"], button[aria-label="Stop"], button[aria-label*="Остановить"]',
  )].find(visible);
  const generating = () => !!stopButton() ||
    [...document.querySelectorAll('[data-is-streaming="true"]')].some(visible);
  const sendButton = (editor) => {
    const selector =
      'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Отправить"]';
    return (
      editor?.closest("form")?.querySelector(selector) ||
      [...document.querySelectorAll(selector)].filter(visible).at(-1) ||
      null
    );
  };

  // Структура сообщений ChatGPT меняется независимо от интерфейса ввода.
  // Определяем автора по пузырю/контенту внутри одного хода, а текст берём
  // из тела сообщения, не из панели действий ("ChatGPT сказал" и т. п.).
  const TURN_SELECTOR =
    '[data-testid^="conversation-turn-"], article[data-turn-id], [data-turn-id]';
  const USER_SELECTOR =
    '[data-testid="user-message"], [data-user-message-bubble], .user-message-bubble-color';
  const ASSISTANT_SELECTOR =
    '[data-testid="assistant-message"], [data-content-search-unit-key], [data-markdown-text-style], .markdown, .prose';
  const ROLE_SELECTOR =
    '[data-message-author-role="user"], [data-message-author-role="assistant"]';

  function turnRole(el) {
    const explicit = el.getAttribute?.("data-message-author-role") ||
      el.querySelector?.(ROLE_SELECTOR)?.getAttribute("data-message-author-role");
    if (explicit === "user" || explicit === "assistant") return explicit;
    if (el.matches?.(USER_SELECTOR) || el.querySelector?.(USER_SELECTOR))
      return "user";
    if (el.matches?.(ASSISTANT_SELECTOR) || el.querySelector?.(ASSISTANT_SELECTOR))
      return "assistant";
    return "";
  }

  function messageText(el, role) {
    const groups = role === "user"
      ? [USER_SELECTOR]
      : [
          '[data-markdown-text-style], .markdown',
          '[data-testid="assistant-message"]',
          '[data-content-search-unit-key]',
          '.prose',
        ];
    for (const selector of groups) {
      const matched = [
        ...(el.matches?.(selector) ? [el] : []),
        ...(el.querySelectorAll?.(selector) || []),
      ];
      // Один и тот же текст может находиться и в .markdown, и в её потомке.
      const roots = matched.filter(
        (n, i) => !matched.some((other, j) => i !== j && other.contains?.(n)),
      );
      const parts = roots.map(read).filter(Boolean);
      if (parts.length) return parts.join("\n");
    }
    return read(el);
  }

  // Считываем только основной диалог, исключая меню, подсказки и черновик.
  function turns() {
    const main = $("main") || $('[role="main"]');
    if (!main) return [];
    const containers = [...main.querySelectorAll(TURN_SELECTOR)].filter(
      (n) => !n.parentElement?.closest(TURN_SELECTOR),
    );
    const result = [];
    for (const el of containers) {
      const role = turnRole(el);
      if (role) result.push({ role, text: messageText(el, role), el });
    }
    // Смешанная/новая разметка: отдельные сообщения без conversation-turn.
    const fallback =
      ROLE_SELECTOR + ', ' + USER_SELECTOR + ', ' + ASSISTANT_SELECTOR;
    for (const el of main.querySelectorAll(fallback)) {
      if (containers.some((root) => root.contains?.(el))) continue;
      if (el.parentElement?.closest(fallback)) continue;
      if (el.closest?.('form, [contenteditable="true"], nav, aside')) continue;
      const role = turnRole(el);
      if (role) result.push({ role, text: messageText(el, role), el });
    }
    result.sort((a, b) =>
      a.el === b.el
        ? 0
        : a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1,
    );
    return result
      .map(({ role, text }) => ({ role, text }))
      .filter((t) => t.text);
  }

  function chatError() {
    const main = $("main") || $('[role="main"]');
    if (!main) return "";
    const pattern =
      /Время ожидания доставки сообщения истекло|message delivery timed out|There was an error generating|Something went wrong|Произошла ошибка при генерации/i;
    const retry = [...main.querySelectorAll("button")]
      .filter(visible)
      .find((b) =>
        /^(Повторить|Retry|Try again|Попробовать снова)$/i.test(read(b)),
      );
    if (retry) {
      let ancestor = retry;
      for (
        let i = 0;
        ancestor && i < 6;
        i++, ancestor = ancestor.parentElement
      ) {
        const t = read(ancestor);
        if (t.length < 1200 && pattern.test(t))
          return "ChatGPT не доставил ответ";
      }
    }
    const alert = [
      ...main.querySelectorAll('[role="alert"], [data-testid*="error"]'),
    ]
      .filter(visible)
      .map(read)
      .find((t) => t.length < 600 && pattern.test(t));
    return alert
      ? "В ChatGPT произошла техническая ошибка"
      : "";
  }

  function fingerprint() {
    const t = turns(),
      a = t.find((x) => x.role === "user"),
      b = t.find((x) => x.role === "assistant");
    if (!a?.text || !b?.text) return "";
    const raw = a.text + "\0" + b.text;
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i++)
      hash = Math.imul(hash ^ raw.charCodeAt(i), 16777619);
    return raw.length + ":" + (hash >>> 0).toString(36);
  }
  // Строка статуса состоит из обычного текста: HTML-теги ChatGPT иногда скрывает.
  function status(answer, cmd) {
    const lines = [
      ...answer.matchAll(
        /(?:^|\n)\s*WD6_STATUS\s+COMMAND_ID=([\w-]+)\s+STATE=(WORKING|PAUSE|PASS|FAIL)\s*(?=\n|$)/g,
      ),
    ];
    if (
      lines.length === 1 &&
      lines[0][1] === cmd &&
      answer.trim().endsWith(lines[0][0].trim())
    )
      return lines[0][2];
    // Поддержка ответов от предыдущих версий расширения.
    const old = [
      ...answer.matchAll(
        /<WD_STATUS>\s*VERSION=1\s*COMMAND_ID=([\w-]+)\s*STATE=(WORKING|PAUSE|PASS|FAIL)\s*<\/WD_STATUS>/g,
      ),
    ];
    return old.length === 1 &&
      old[0][1] === cmd &&
      answer.trim().endsWith(old[0][0])
      ? old[0][2]
      : null;
  }
  function replyFor(cmd) {
    const t = turns();
    const i = t.findLastIndex(
      (x) =>
        x.role === "user" &&
        x.text.includes("[WATCHDOG LITE]") &&
        x.text.includes(`COMMAND_ID=${cmd}`),
    );
    if (i >= 0) {
      const after = t.slice(i + 1);
      const userTurns = after.filter(x => x.role === "user").length;
      const lastUser = after.findLastIndex(x => x.role === "user");
      const answer =
        after.slice(lastUser + 1).filter(x => x.role === "assistant").at(-1)?.text || "";
      return { sent: true, answer, userTurns };
    }
    // Если разметка чата изменилась, можно подтвердить отправку, но не результат.
    // Статус в общем тексте страницы может оказаться цитатой из сообщения пользователя.
    const page = read($("main") || $('[role="main"]') || document.body);
    const marker = `COMMAND_ID=${cmd}`;
    const sent = page.includes("[WATCHDOG LITE]") && page.includes(marker);
    return { sent, answer: "", unreadable: sent };
  }
  function instruction(kind, cmd, j) {
    const purpose = {
      BOOT: "Продолжай исходное задание в этом диалоге. Сначала проверь, что уже сделано. Не повторяй выполненные действия.",
      CONTINUE:
        "Продолжай исходное незавершённое задание без повторения выполненных действий.",
      REPAIR:
        "Не выполняй новую работу. Укажи только состояние результата предыдущего ответа.",
      RESCUE:
        "Предыдущий ответ завершился технической ошибкой. Проверь фактическое состояние и продолжай с места остановки без повторения выполненных действий.",
    }[kind];
    return `[WATCHDOG LITE]
MESSAGE_KIND=${kind}
COMMAND_ID=${cmd}

${purpose}

У Watchdog нет ограничения времени на запуск. Продолжай работу до проверенного результата, запроса к пользователю или объективной невозможности завершения. Не объявляй задачу готовой только из-за длительности работы.

Состояния:
WORKING — можешь продолжать незавершённую работу без ответа пользователя.
PAUSE — нужен ответ, выбор или разрешение пользователя. Коротко задай конкретный вопрос и жди; не продолжай работу сам.
PASS — задача выполнена и результат проверен настолько, насколько доступно.
FAIL — завершить задачу невозможно. Укажи причину и что осталось.

В конце каждого ответа дай краткий отчёт, без общих обещаний:
Сделано: 1–3 конкретных факта; укажи количество изменённых или созданных объектов, если оно известно.
Проверки: сколько выполнено, сколько успешно, сколько с ошибкой; если не запускались — так и напиши.
Осталось: следующий шаг или блокер; если всё завершено — «ничего».
Не придумывай числа, время, проценты готовности и результаты проверок. План не считай сделанной работой.

После обычного сообщения пользователя сохраняй этот COMMAND_ID и снова указывай состояние в своём новом ответе. Watchdog снимет PAUSE только по новому ответу после сообщения пользователя: WORKING продолжает запуск, PASS или FAIL завершает его, PAUSE оставляет ожидание.
Последней строкой ответа напиши строго: WD6_STATUS COMMAND_ID=${cmd} STATE=<одно значение>. Используй только WORKING, PAUSE, PASS или FAIL. Эта строка — обычный текст, без HTML-тегов и блока кода.`;
  }

  let tabId,
    busy = false,
    lastSample = "",
    stableSince = 0;
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (m?.type === "PING") reply({ ok: true });
  });
  rpc({ type: "IDENTIFY" })
    .then((r) => {
      tabId = r?.tabId;
    })
    .catch(() => {});
  const all = async () => (await rpc({ type: "GET" })).jobs || {};
  const job = async () =>
    Object.values(await all()).find(
      (j) => (j.mode === "RUNNING" || (j.mode === "PAUSED" && j.result === "PAUSE")) &&
        j.tabId === tabId,
    );
  async function patch(j, fields) {
    const r = await rpc({
      type: "PATCH",
      id: j.id,
      runId: j.runId,
      expectedUrl: j.url,
      expectedPhase: j.phase,
      patch: fields,
    });
    return r?.ok ? r.job : null;
  }
  const error = (j, reason) =>
    patch(j, { mode: "ERROR", error: reason, detail: "", attention: "" });
  const detail = (j, text) =>
    j.detail === text ? Promise.resolve(j) : patch(j, { detail: text });
  const pause = (j, userCount, text) => patch(j, {
    mode: "PAUSED", phase: "PAUSE", result: "PAUSE",
    pauseUserCount: userCount, detail: text, error: "", attention: "",
  });
  const finish = (j, state) => patch(j, {
    mode: "DONE", phase: "DONE", result: state,
    detail: state === "PASS" ? "ChatGPT сообщил, что задача выполнена" :
      "ChatGPT сообщил, что не может закончить задачу",
    error: "", attention: "",
  });
  async function observePause(j, reply) {
    if (generating()) {
      stable("PAUSE_GENERATING", j.cmd);
      return detail(j, "ChatGPT отвечает на ваше сообщение");
    }
    if (!(reply.userTurns > (j.pauseUserCount || 0))) {
      return detail(j, "Жду вашего ответа в чате");
    }
    if (!reply.answer) return detail(j, "Жду новый ответ ChatGPT");
    if (!stable(j.cmd + ":resume:" + reply.userTurns, reply.answer)) return;
    const state = status(reply.answer, j.cmd);
    if (state === "WORKING") return send(j, "CONTINUE");
    if (state === "PASS" || state === "FAIL") return finish(j, state);
    if (state === "PAUSE") return pause(j, reply.userTurns, "ChatGPT ждёт вашего ответа");
    return detail(j, "В новом ответе нет статуса. Попросите ChatGPT указать WORKING, PAUSE, PASS или FAIL с прежним COMMAND_ID.");
  }
  // Перезагрузка может стереть черновик, поэтому оставляем её пользователю.
  async function recover(j, reason) {
    return error(
      j,
      `${reason}. Проверьте вкладку и при необходимости перезагрузите её вручную.`,
    );
  }
  function stable(key, value) {
    const text = key + "\n" + value;
    if (lastSample !== text) {
      lastSample = text;
      stableSince = Date.now();
    }
    return Date.now() - stableSince >= LIMIT.stable;
  }
  function fill(el, text) {
    el.focus();
    if (el.matches("textarea,input")) {
      const prototype = el.matches("textarea")
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const selection = window.getSelection(),
        range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("insertText", false, text);
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText" }),
      );
    }
  }
  async function send(j, kind) {
    if (j.turn >= LIMIT.maxTurns)
      return error(
        j,
        "Отправлено 100 сообщений. Проверьте результат и при необходимости запустите снова.",
      );
    // RESCUE — новый технический запрос, а не повтор исходного задания.
    if (generating() || (chatError() && !j.ignoreError && kind !== "RESCUE"))
      return;
    if (kind === "RESCUE" && (j.rescues || 0) >= LIMIT.rescue)
      return error(j, "Две попытки вывести ChatGPT из зависания исчерпаны");
    const editor = composer();
    if (!editor) return recover(j, "Не найдено поле ввода");
    if (draftText(editor))
      return detail(
        j,
        "Жду, пока вы отправите или уберёте черновик",
      );
    const anchor = j.tabOnly ? fingerprint() : "";
    if (j.tabOnly && (!anchor || (j.anchor && j.anchor !== anchor)))
      return error(j, "Не удалось подтвердить историю GPT");
    const cmd = "cmd-" + crypto.randomUUID();
    const count = (j.rescues || 0) + (kind === "RESCUE" ? 1 : 0);
    const updated = await patch(j, {
      mode: "RUNNING",
      result: "",
      pauseUserCount: 0,
      phase: "SENDING",
      kind,
      cmd,
      anchor: anchor || j.anchor,
      since: Date.now(),
      detail:
        kind === "RESCUE"
          ? `Пробую продолжить после ошибки: попытка ${count} из ${LIMIT.rescue}`
          : "Готовлю сообщение",
      turn: j.turn + 1,
      repairs: kind === "REPAIR" ? j.repairs + 1 : 0,
      recoveries: 0,
      rescues: count,
      ignoreError: kind === "RESCUE" || !!j.ignoreError,
      attention: "",
    });
    if (!updated) return;
    // Повторная проверка после записи намерения: пользователь мог начать печатать.
    if (draftText(editor)) {
      return patch(updated, {
        mode: j.mode,
        result: j.result,
        pauseUserCount: j.pauseUserCount || 0,
        phase: j.phase,
        cmd: j.cmd,
        kind: j.kind,
        turn: j.turn,
        rescues: j.rescues,
        repairs: j.repairs,
        ignoreError: j.ignoreError,
        detail:
          "Жду, пока вы отправите или уберёте черновик",
      });
    }
    const payload = instruction(kind, cmd, j);
    fill(editor, payload);
    if (!sameText(draftText(editor), payload))
      return error(
        updated,
        "Редактор не подтвердил вставку команды. Отправка отменена.",
      );
    let button;
    for (let i = 0; i < 12; i++) {
      button = sendButton(editor);
      if (button && !button.disabled) break;
      await wait(200);
    }
    if (!button || button.disabled) {
      if (sameText(draftText(editor), payload)) fill(editor, "");
      return error(
        updated,
        "Кнопка отправки недоступна. Команда не отправлена.",
      );
    }
    const check = await rpc({ type: "CHECK", id: j.id, runId: j.runId, cmd });
    if (
      !check?.ok ||
      generating() ||
      (chatError() && !updated.ignoreError) ||
      url() !== updated.url ||
      !sameText(draftText(editor), payload)
    ) {
      if (sameText(draftText(editor), payload)) fill(editor, "");
      return error(
        updated,
        "Обстановка перед отправкой изменилась; команда не отправлена",
      );
    }
    button.click(); // После неоднозначного клика тот же COMMAND_ID не отправляется второй раз.
    await patch(updated, {
      phase: "WAIT",
      since: Date.now(),
      detail:
        kind === "RESCUE"
          ? `Попросил продолжить после ошибки: попытка ${count} из ${LIMIT.rescue}`
          : "Сообщение отправлено. Жду ответ ChatGPT",
    });
  }

  async function tick() {
    if (busy || tabId == null) return;
    busy = true;
    try {
      let j = await job();
      if (!j) return;
      if (j.url !== url()) {
        if (
          j.tabOnly &&
          url().startsWith(j.url + "/c/") &&
          j.anchor &&
          fingerprint() === j.anchor
        )
          await rpc({
            type: "UPGRADE",
            id: j.id,
            runId: j.runId,
            anchor: j.anchor,
          });
        return;
      }
      if (j.tabOnly && j.anchor && fingerprint() !== j.anchor)
        return await error(j, "Вкладка GPT показывает другую переписку");
      const now = Date.now();
      if (now - j.seen > 20_000) j = (await patch(j, { seen: now })) || j;
      if (j.phase === "PAUSE") return await observePause(j, replyFor(j.cmd));
      const issue = chatError();
      // Ошибка предыдущего хода может продолжать висеть после успешного RESCUE.
      // Игнорируем её до исчезновения плашки, но ждём подтверждения каждого нового ответа.
      if (!issue && (j.ignoreError || j.rescues || j.attention))
        j =
          (await patch(j, { ignoreError: false, rescues: 0, attention: "" })) ||
          j;
      const unresolved = issue && !j.ignoreError;
      const age = now - j.since;

      if (j.phase === "BOOT") {
        if (!composer()) {
          await detail(j, "Жду загрузки поля ввода");
          return (
            age > LIMIT.page && (await recover(j, "Страница не загрузилась"))
          );
        }
        if (generating()) {
          stable("GENERATING", "");
          await detail(j, "ChatGPT отвечает");
          return;
        }
        if (j.tabOnly && !fingerprint()) {
          await detail(j, "Проверяю историю чата GPT");
          return (
            age > LIMIT.history &&
            (await error(j, "Невозможно подтвердить диалог без /c/"))
          );
        }
        if (unresolved) {
          await detail(
            j,
            "В ChatGPT произошла ошибка. Пробую продолжить",
          );
          if (stable("ERROR", issue)) return await send(j, "RESCUE");
          return;
        }
        await detail(j, "Чат открыт. Готовлю запуск");
        const tail = read(
          $("main") || $('[role="main"]') || document.body,
        ).slice(-350);
        if (!stable("READY", url() + "\n" + tail)) return;
        return await send(j, "BOOT");
      }
      if (j.phase === "SENDING") {
        if (replyFor(j.cmd).sent)
          return await patch(j, { phase: "WAIT", since: now });
        // Если клик был сделан, но отправка неизвестна, не повторяем его без подтверждения.
        return (
          age > LIMIT.send &&
          (await error(j, "Не удалось подтвердить отправку. Проверьте последнее сообщение в чате перед новым запуском."))
        );
      }
      if (j.phase !== "WAIT") return await error(j, "Неизвестное состояние");
      const reply = replyFor(j.cmd);
      if (reply.userTurns > 0) {
        return await pause(j, reply.userTurns - 1, "Вы написали в чат. Жду ответ ChatGPT");
      }
      if (generating()) {
        await detail(j, "ChatGPT отвечает");
        stable("GENERATING", j.cmd);
        return;
      }

      if (reply.unreadable && age > LIMIT.page) {
        return await error(j, "Не удалось распознать сообщения на странице. Перезагрузите вкладку и попробуйте снова.");
      }

      // Правильный статус важнее старой красной плашки ошибки.
      if (reply.answer && stable(j.cmd, reply.answer)) {
        const s = status(reply.answer, j.cmd);
        if (s === "PASS" || s === "FAIL")
          return await finish(j, s);
        if (s === "PAUSE") return await pause(j, reply.userTurns, "ChatGPT ждёт вашего ответа");
        if (s === "WORKING") return await send(j, "CONTINUE");
        if (j.repairs < LIMIT.repair) return await send(j, "REPAIR");
        return await error(
          j,
          "ChatGPT дважды не указал результат. Проверьте ответ в чате.",
        );
      }

      if (unresolved) {
        await detail(
          j,
          "В ChatGPT произошла ошибка. Пробую продолжить",
        );
        if (stable("ERROR", issue)) return await send(j, "RESCUE");
        return;
      }
      // Если спасательное сообщение тоже не получило ответа, разрешена одна
      // дополнительная попытка только при наличии того же сбоя и по таймауту.
      if (
        issue &&
        j.ignoreError &&
        age >= LIMIT.rescueWait &&
        reply.sent &&
        !reply.answer
      ) {
        if ((j.rescues || 0) < LIMIT.rescue) return await send(j, "RESCUE");
        return await error(j, "ChatGPT не ответил после двух попыток продолжения. Проверьте вкладку.");
      }
      if (!reply.sent) {
        await detail(j, "Жду, пока сообщение появится в чате");
        return (
          age > LIMIT.page &&
          (await error(j, "Не удалось подтвердить отправку. Проверьте последнее сообщение в чате перед новым запуском."))
        );
      }
      await detail(
        j,
        j.kind === "RESCUE"
          ? "Попросил продолжить после ошибки. Жду ответ"
          : "Жду ответ ChatGPT",
      );
    } catch (e) {
      const j = await job().catch(() => null);
      if (j && j.url === url())
        await error(j, String(e.message || e)).catch(() => {});
    } finally {
      busy = false;
    }
  }
  setInterval(tick, 1600);
  tick();
})();
