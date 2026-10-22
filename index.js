// Ghostpen v0.4.0 - SillyTavern 대필 확장 (버전을 올릴 때 이 주석과 아래 VERSION을 같이 고칠 것)
const MODULE = 'ghostpen';
const VERSION = '0.4.0';

const LENGTH_PRESETS = { short: [300, 500], normal: [500, 800], long: [800, 1200] }; // 글자 수 (공백 포함)
const INT_LABEL = { weak: '약', mid: '중', strong: '강' };
const MODE = {
    first: { label: '1인칭', icon: 'fa-user', flag: 'showFirst' },
    third: { label: '3인칭', icon: 'fa-users', flag: 'showThird' },
    keep:  { label: '고정X', icon: 'fa-ghost', flag: 'showKeep' },
};
const DEFAULTS = {
    showFirst: true, showThird: true, showKeep: true,
    intensity: 'mid',     // weak | mid | strong
    minChars: 500, maxChars: 800,
    maxTokens: 5000,      // 출력 토큰 상한
    recent: 5,
    profileId: '',        // '' = 선택 안 함
    timeoutSec: 120,
    logs: [],
};
const MAX_LOGS = 20;
let curTab = 'set';
let advOpen = false;
let lastOriginal = null; // 직전 원문 (메모리에만 보관)

const ctx = () => SillyTavern.getContext();
function S() {
    const es = ctx().extensionSettings;
    if (!es[MODULE]) es[MODULE] = {};
    const st = es[MODULE];
    if (st.minChars === undefined) { // 이전 설정 이전
        const OLD_WORDS = { short: [60, 100], normal: [130, 200], long: [230, 350] };
        const byLength = { short: 'short', medium: 'normal', long: 'long' }[st.length];
        const byWords = Object.entries(OLD_WORDS).find(([, [x, y]]) => x === st.minWords && y === st.maxWords)?.[0];
        const key = byLength || byWords;
        if (key) { st.minChars = LENGTH_PRESETS[key][0]; st.maxChars = LENGTH_PRESETS[key][1]; }
        else if (st.minWords && st.maxWords) { st.minChars = Math.round(st.minWords * 4 / 50) * 50; st.maxChars = Math.round(st.maxWords * 4 / 50) * 50; }
    }
    for (const k of Object.keys(DEFAULTS)) if (st[k] === undefined) st[k] = structuredClone(DEFAULTS[k]);
    if (st.maxTokens === 4096) st.maxTokens = 5000; // 이전 기본값 이전
    return st;
}
const save = () => ctx().saveSettingsDebounced();
const matchPreset = st => Object.entries(LENGTH_PRESETS).find(([, [a, b]]) => a === st.minChars && b === st.maxChars)?.[0];

/* 프롬프트 */
const SYSTEM_PROMPT = [
    `[Purpose]`,
    `Ghostwrite the <draft> into a finished passage that can be sent to the RP as is.`,
    ``,
    `[Rules]`,
    `If rules conflict, follow this order: [Request] (if present) -> Rules 1-3 -> point of view -> intensity.`,
    ``,
    `1. Reflect every action and every line of dialogue in the draft, in the original order, without omitting any. Do not change their content, order, meaning, or cause-and-effect.`,
    `2. Keep text inside double quotes (" ") exactly as it appears in the draft. Do not change or drop any word, punctuation mark, or spacing.`,
    `3. Do not add dialogue, actions, events, or characters that are not in the draft. Do not write any result that follows the draft or the other party's reaction. You may describe in concrete detail how an existing action is carried out. Example: "He opened the door" -> he turned the handle and pushed the door open (allowed) / "He went out into the hallway" (forbidden). The only exception is the [Empty draft] section, when it is present.`,
    ``,
    `[Description]`,
    `- The amount and depth of description follow the selected intensity.`,
    `- For every character, describe emotions, inner thoughts, and sensations only when the draft, the recent chat, the character description, or the persona supports them and the selected point of view allows them to be narrated.`,
    `- You may add the light, sound, temperature, and atmosphere of a place that already appears in the draft or the recent chat, when it suits the scene. Do not invent appearance, belongings, backstory, or surroundings that the context does not contain.`,
    `- Do not repeat the same information or feeling. Fix grammar errors, awkward connections, and repeated words.`,
    `- Use the character description, the persona, and the recent chat only to understand the context. Do not copy or summarize them, and do not retell what has already happened.`,
    ``,
    `[Output]`,
    `- Output only the finished passage. Do not add reasoning, information blocks, or anything else.`,
    `- Write in the same language as the draft. If the draft is empty, write in Korean.`,
    `- End any narration you newly write with a complete sentence. Text inside double quotes stays exactly as in the draft, even if it is unfinished.`,
].join('\n');

const PERSPECTIVE = {
    first: [
        `[Point of view: first person]`,
        `- Rewrite all narration outside double quotes from {{user}}'s first-person point of view. Change sentences only as far as the conversion requires.`,
        `- Do not narrate other characters' inner thoughts or sensations.`,
    ].join('\n'),
    third: [
        `[Point of view: third person]`,
        `- Narrate in third person, and do not lock the point of view to any one character.`,
        `- If there are no point-of-view cues, narrate mainly through outwardly visible actions, gestures, sounds, and the space.`,
        `- If the draft is not in third person, rewrite all narration outside double quotes in third person.`,
    ].join('\n'),
    keep: [
        `[Point of view: no fixed person]`,
        `- Keep the draft's person and point of view exactly as they are. Even if they are mixed, do not unify or change them.`,
        `- Rewrite the narration naturally in line with the draft's person and point of view.`,
        `- Newly written narration follows the person and point of view of the sentence immediately before it.`,
    ].join('\n'),
};

const INTENSITY = {
    weak: [
        `[Intensity: Light]`,
        `- Keep the draft's wording and structure as much as possible.`,
        `- Supplement the process, sensation, and setting of actions only a little.`,
        `- Describe emotions only to the extent the draft shows them.`,
    ].join('\n'),
    mid: [
        `[Intensity: Medium]`,
        `- Recompose sentences naturally, but keep the order and structure of the actions.`,
        `- Expand the process, sensation, and setting of actions in concrete terms.`,
        `- Supplement emotion and psychology within what the context supports, without overdoing it.`,
    ].join('\n'),
    strong: [
        `[Intensity: Strong]`,
        `- Actively recompose sentences and paragraphs.`,
        `- Describe the process, sensation, and setting of actions richly.`,
        `- Describe the flow of emotion and psychology in depth.`,
    ].join('\n'),
};

const EMPTY_INSTRUCTION = [
    `[Empty draft]`,
    `- Based on the recent chat, write {{user}}'s next turn, once. Only in this case may you add new dialogue and actions.`,
    `- The intensity applies to the amount and depth of description.`,
    `- Person and point of view follow the selected point-of-view rule. Under "no fixed person", follow {{user}}'s recent chat messages; if there are none, write in third person.`,
    `- Do not write {{char}}'s actions, dialogue, inner thoughts, or reactions.`,
].join('\n');

// 줄 맨 앞이 //인 첫 줄부터 끝까지를 요청으로, 그 앞을 초안으로 나눈다
function splitRequest(text) {
    const m = /(^|\n)\/\/[^\S\n]?/.exec(text);
    if (!m) return { draft: text, request: '' };
    return { draft: text.slice(0, m.index), request: text.slice(m.index + m[0].length).trim() };
}

const REQUEST_INSTRUCTION = [
    `[Request]`,
    `- The user attached the request below. It takes priority over Rules 1-3 and the intensity, but apply it only to what it mentions; follow the rules for everything else.`,
    `- If the request asks to change dialogue, you may change text inside double quotes as the request says.`,
].join('\n');

function buildMessages(input, mode, st, request = '') {
    const c = ctx();
    const ch = (c.characterId !== undefined && c.characters) ? c.characters[c.characterId] : null;
    const persona = c.powerUserSettings?.persona_description || '';
    const recent = (c.chat || []).filter(m => !m.is_system && m.mes).slice(-Math.max(0, Number(st.recent) || 0))
        .map(m => `${m.name}: ${m.mes}`).join('\n\n');
    const hasInput = !!input.trim();
    const parts = [
        `[Character description: ${ch?.name || c.name2 || ''}]\n${ch?.description || '(none)'}`,
        `[Persona of {{user}}: ${c.name1 || ''}]\n${persona || '(none)'}`,
        `[Recent chat]\n${recent || '(none)'}`,
        PERSPECTIVE[mode],
        INTENSITY[st.intensity] || INTENSITY.mid,
        ...(hasInput ? [] : [EMPTY_INSTRUCTION]),
        ...(request ? [`${REQUEST_INSTRUCTION}\n<request>\n${request}\n</request>`] : []),
        `[Length]\nRecommended length: ${st.minChars} to ${st.maxChars} characters, including spaces. Rules 1-3 take priority over it, so do not add events that are not in the draft. Reach the length by describing in concrete detail the process, sensation, atmosphere, and emotion of the actions that are already there. Do not repeat the same content.`,
        `<draft>\n${hasInput ? input : ''}\n</draft>`,
    ];
    const sub = t => c.substituteParams ? c.substituteParams(t) : t;
    return [
        { role: 'system', content: sub(SYSTEM_PROMPT) },
        { role: 'user', content: sub(parts.join('\n\n')) },
    ];
}

/* 유틸 */
const esc = t => String(t ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
// 키/토큰 형태 문자열은 가림
const maskSecrets = t => String(t ?? '')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[가림]')
    .replace(/\b(?:sk-|AIza|ghp_|xox[bap]-)[A-Za-z0-9_-]{8,}/g, '[가림]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[가림]');
const deviceInfo = () => (navigator.userAgent.match(/Android|iPhone|iPad|Windows|Macintosh|Linux/) || ['기기 미상'])[0];
// 큰따옴표 안의 내용만 보존 대상
function extractQuoted(text) {
    return text.match(/"[^"\n]+"/g) || [];
}

function explainError(net, detail) {
    const t = `${net} ${detail}`;
    if (/429|RESOURCE_EXHAUSTED|rate limit|quota/i.test(t)) return '서버(제공사)의 사용량 한도 초과예요. 확장 문제가 아니에요. 잠시 후 다시 시도하거나 할당량/모델/지역 설정을 확인하세요.';
    if (/401|403|UNAUTHENTICATED|PERMISSION_DENIED|api key|credential/i.test(t)) return '인증 또는 권한 문제예요. API 키, 프로젝트, 권한 설정을 확인하세요.';
    if (/404|NOT_FOUND/i.test(t)) return '모델 또는 지역(엔드포인트)을 찾을 수 없어요. 모델 이름과 지역 설정을 확인하세요.';
    if (/400|INVALID_ARGUMENT/i.test(t)) return '요청 형식이 거절됐어요. 모델이 지원하지 않는 설정이 있을 수 있어요.';
    if (/50[0-9]|UNAVAILABLE|INTERNAL/i.test(t)) return '서버 쪽 오류예요. 잠시 후 다시 시도하세요.';
    return '';
}

/* 기록 */
function addLog(entry) {
    const st = S();
    const clean = {};
    for (const [k, v] of Object.entries(entry)) clean[k] = typeof v === 'string' ? maskSecrets(v) : v;
    st.logs.unshift({ time: new Date().toLocaleString('ko-KR'), ...clean });
    st.logs = st.logs.slice(0, MAX_LOGS);
    save();
    refreshLogViews();
}
function formatLog(l) {
    const lines = [`[${l.time}] ${l.result}`];
    const map = [['stage', '단계'], ['reason', '원인'], ['detail', '상세'], ['hint', '해석'], ['mode', '시점'], ['intensity', '강도'],
        ['length', '권장 분량'], ['source', '요청 대상'], ['api', 'API'], ['inputChars', '원문 글자수'], ['userRequest', '추가 요청'],
        ['outputChars', '결과 글자수'], ['finish', '종료 사유'], ['request', '요청 정보'],
        ['cancel', '취소 지원'], ['network', '서버 응답'], ['cause', '상세 원인(cause)'], ['elapsed', '경과 시간'], ['env', '환경']];
    for (const [k, label] of map) if (l[k] !== undefined && l[k] !== '') lines.push(`  ${label}: ${l[k]}`);
    return lines.join('\n');
}
function renderLogItems() {
    const logs = S().logs;
    if (!logs.length) return '<div class="gpen-empty gpen-muted">기록이 없어요.</div>';
    return logs.map((l, i) => `<details class="gpen-log ${l.level === 'warn' ? 'warn' : 'fail'}"><summary>${esc(l.time)} · ${esc(l.reason || l.result)}</summary><div class="gpen-logbody"><button type="button" class="gpen-btn gpen-copy-one" data-i="${i}"><i class="fa-solid fa-copy"></i><span>이 기록 복사</span></button><pre>${esc(formatLog(l))}</pre></div></details>`).join('');
}
function refreshLogViews() {
    $('.gpen-loglist').html(renderLogItems());
    $('.gpen-badge').text(S().logs.length);
}

/* 연결 */
function resolveConnection(st) {
    // 프로필 선택 시 그 프로필, 아니면 현재 연결
    if (st.profileId) {
        const profiles = ctx().extensionSettings.connectionManager?.profiles || [];
        const profile = profiles.find(p => p.id === st.profileId);
        return { kind: 'profile', profileId: st.profileId, profile, missing: !profile };
    }
    return { kind: 'raw', profileId: '', profile: null, missing: false };
}

/* 생성 */
let run = null;
let runCounter = 0;

function parseResponse(res) {
    if (typeof res === 'string') return { text: res, finish: '' };
    const choice = res?.choices?.[0];
    const text = res?.content?.[0]?.text ?? (typeof res?.content === 'string' ? res.content : undefined)
        ?? choice?.message?.content ?? choice?.text ?? '';
    const finish = choice?.finish_reason || res?.stop_reason || res?.finish_reason || '';
    return { text: typeof text === 'string' ? text : String(text ?? ''), finish };
}

const GEN_URL = /\/api\/backends\/[^/?]+\/generate(?:$|\?)/;

async function runGhostpen(mode) {
    const c = ctx();
    const st = S();
    const ta = document.getElementById('send_textarea');
    const rawText = ta.value;
    const { draft: input, request } = splitRequest(rawText);
    const id = ++runCounter;
    const controller = new AbortController();
    run = { id, controller, mode, cancelled: false, timedOut: false };
    setBusy(mode, true);
    const t0 = Date.now();
    const conn = resolveConnection(st);
    const log = {
        mode: MODE[mode].label, intensity: INT_LABEL[st.intensity], length: `${st.minChars}~${st.maxChars}자 / 최대 출력 ${st.maxTokens}토큰`,
        source: conn.kind === 'profile' ? `프로필: ${conn.profile?.name || '찾을 수 없음'}` : '선택 안 함 (지금 사용 중인 연결과 프리셋 그대로)',
        api: conn.profile?.api || c.mainApi || '', inputChars: input.length, userRequest: maskSecrets(request).slice(0, 300),
        env: `확장 v${VERSION} / ${deviceInfo()}`,
    };
    let stage = '준비';
    let netInfo = '';
    const origFetch = window.fetch;
    let attached = false;
    const wrappedFetch = async function (...args) {
        try {
            const url0 = String(args[0]?.url || args[0]);
            if (conn.kind === 'raw' && !attached && GEN_URL.test(url0)) {
                attached = true; // 생성 요청에 취소 신호 연결
                const init = { ...(args[1] || {}) };
                const merged = new AbortController();
                const forward = () => merged.abort();
                controller.signal.addEventListener('abort', forward, { once: true });
                const own = init.signal;
                if (own) { if (own.aborted) merged.abort(); else own.addEventListener('abort', forward, { once: true }); }
                init.signal = merged.signal;
                args = [args[0], init];
            }
        } catch { /* 무시 */ }
        const res = await origFetch.apply(this, args);
        try {
            const url = String(args[0]?.url || args[0]);
            if (!res.ok && !netInfo && GEN_URL.test(url)) {
                const body = await res.clone().text();
                netInfo = `HTTP ${res.status} ${res.statusText} ${url.split('?')[0]} → ${maskSecrets(body).slice(0, 500) || '(본문 없음)'}`;
            }
        } catch { /* 무시 */ }
        return res;
    };
    window.fetch = wrappedFetch;
    const timer = setTimeout(() => { if (run) run.timedOut = true; controller.abort(); }, Math.max(10, st.timeoutSec) * 1000);
    try {
        if (conn.missing) throw new Error('선택한 연결 프로필을 찾을 수 없어요. 프로필이 삭제됐을 수 있어요. 설정에서 다시 고르거나 "선택 안 함"으로 바꿔 주세요.');
        const messages = buildMessages(input, mode, st, request);
        const maxTokens = Math.max(256, Number(st.maxTokens) || DEFAULTS.maxTokens);
        log.request = `메시지 ${messages.length}개 / 시스템 ${messages[0].content.length}자 / 사용자 ${messages[1].content.length}자 / 최대 출력 ${maxTokens}`;

        let res;
        if (conn.kind === 'raw') {
            if (typeof c.generateRaw !== 'function') throw new Error('generateRaw를 찾을 수 없어요. SillyTavern을 업데이트하거나 연결 프로필을 만들어 주세요.');
            stage = 'API 요청 (지금 사용 중인 연결)';
            const p = c.generateRaw({
                prompt: c.mainApi === 'openai' ? messages.slice(1) : messages[1].content,
                systemPrompt: messages[0].content, responseLength: maxTokens, trimNames: false,
            });
            p.catch(() => {});
            const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new DOMException('요청이 중단되었어요.', 'AbortError'))));
            res = await Promise.race([p, aborted]);
            log.cancel = attached ? '취소 시 요청을 끊을 수 있어요' : '요청 주소를 찾지 못해 취소해도 서버 생성이 계속될 수 있어요';
        } else {
            const Svc = c.ConnectionManagerRequestService;
            if (!Svc) throw new Error('ConnectionManagerRequestService를 찾을 수 없어요. SillyTavern을 최신 버전으로 업데이트하고 Connection Manager 확장이 켜져 있는지 확인하세요.');
            stage = 'API 요청';
            res = await Svc.sendRequest(conn.profileId, messages, maxTokens,
                { stream: false, signal: controller.signal, extractData: false, includePreset: true, includeInstruct: true }, {});
        }

        if (run?.id !== id || run.cancelled) return; // 취소된 요청은 무시
        stage = '응답 검사';
        const { text: raw, finish } = parseResponse(res);
        log.finish = finish || '(정보 없음)';
        const out = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^```[a-z]*\n?|\n?```$/g, '').replace(/^\s*<draft>\s*|\s*<\/draft>\s*$/gi, '').trim();
        log.outputChars = out.length;
        if (!out) {
            throw new Error(/length|max_tokens/i.test(finish)
                ? '응답이 비어 있어요. 출력 토큰 상한에 걸렸을 수 있어요. 추론 모델은 생각에도 토큰을 쓰니 고급에서 최대 출력 토큰을 늘려 보세요.'
                : '응답이 비어 있어요.');
        }

        // 결과는 항상 입력창에 넣고 경고만 기록
        const warns = [];
        if (/length|max_tokens/i.test(finish)) warns.push('결과가 출력 길이 상한에서 잘렸을 수 있어요.');
        if (out.length < st.minChars - 200) warns.push('권장 분량보다 많이 짧아요.');
        const quoted = request ? [] : extractQuoted(input); // 요청이 있으면 대사 변경이 의도일 수 있어 검사하지 않음
        const changed = quoted.filter(q => !out.includes(q)).length;
        if (changed) warns.push(`따옴표 안 내용 ${quoted.length}개 중 ${changed}개가 원문과 달라요.`);

        lastOriginal = rawText; // 요청 줄까지 포함해서 보관
        ta.value = out;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
        updateRestoreUI();
        if (warns.length) {
            addLog({ level: 'warn', result: '⚠️ 결과는 입력창에 반영됨', reason: '확인 필요', detail: warns.join(' / '), ...log, elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}초` });
        }
    } catch (e) {
        if (!run || run.id !== id || run.cancelled) return; // 취소는 실패 아님
        const timedOut = run.timedOut;
        toastr.error('대필 실패 😢')?.css({ 'border-radius': '14px', 'background-color': '#e5586b', 'background-image': 'none', color: '#fff' });
        const detail = timedOut ? `${st.timeoutSec}초 안에 응답이 오지 않았어요.` : String(e?.message || e).slice(0, 600);
        addLog({
            level: 'fail', result: '❌ 실패', stage,
            reason: timedOut ? '시간 초과' : (e?.name || 'Error'),
            detail,
            hint: explainError(netInfo, detail),
            network: netInfo || '(감지된 서버 오류 응답 없음)',
            cause: e?.cause ? String(e.cause?.message || e.cause).slice(0, 300) : '',
            ...log, elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}초`,
        });
    } finally {
        clearTimeout(timer);
        if (window.fetch === wrappedFetch) window.fetch = origFetch;
        if (run && run.id === id) { run = null; setBusy(mode, false); }
    }
}

function onIconClick(mode) {
    if (run) {
        if (run.mode === mode) { const m = run.mode; run.cancelled = true; run.controller.abort(); run = null; setBusy(m, false); }
        return;
    }
    runGhostpen(mode);
}
function setBusy(mode, busy) {
    $('#ghostpen_bar').toggleClass('gpen-busy', busy);
    $('#ghostpen_bar .gpen-icon[data-mode]').each(function () {
        const m = $(this).data('mode');
        const active = busy && m === mode;
        $(this).toggleClass('gpen-active', active);
        $(this).find('i').attr('class', `fa-solid ${active ? 'fa-spinner fa-spin' : MODE[m].icon}`);
    });
}

/* 원문 복원 */
function updateRestoreUI() {
    const has = lastOriginal !== null;
    $('#ghostpen_bar .gpen-restore').toggleClass('gpen-show', has);
    $('.gpen-restore-btn').toggleClass('gpen-dim', !has);
}
function restoreOriginal() {
    if (lastOriginal === null) return;
    const ta = document.getElementById('send_textarea');
    ta.value = lastOriginal;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    lastOriginal = null;
    updateRestoreUI();
}
function clearOriginal() { lastOriginal = null; updateRestoreUI(); }

/* UI */
function buildBar() {
    $('#ghostpen_bar').remove();
    const st = S();
    const active = Object.entries(MODE).filter(([, v]) => st[v.flag]);
    if (!active.length) { updateRestoreUI(); return; } // 아이콘을 모두 끄면 숨김
    const bar = $('<div id="ghostpen_bar"></div>');
    $('<div class="gpen-icon gpen-restore" title="원문 복원"><i class="fa-solid fa-rotate-left"></i></div>').on('click', restoreOriginal).appendTo(bar);
    for (const [k, v] of active) {
        $(`<div class="gpen-icon" data-mode="${k}" title="${v.label}"><i class="fa-solid ${v.icon}"></i></div>`)
            .on('click', () => onIconClick(k)).appendTo(bar);
    }
    // 입력창 바로 윗줄
    const nonQR = $('#nonQRFormItems');
    if (nonQR.length) nonQR.before(bar); else $('#send_form').prepend(bar);
    updateRestoreUI();
}

function syncLengthUI(root) {
    const s = S();
    root.find('.gpen-step').each(function () { $(this).find('.gpen-step-val').text(s[$(this).data('step-k')]); });
    const m = matchPreset(s);
    root.find('[data-lenp]').each(function () { $(this).toggleClass('gpen-on', $(this).data('lenp') === m); });
}

function renderPanel(root) {
    const st = S();
    const cm = ctx().extensionSettings.connectionManager;
    const profiles = cm?.profiles || [];
    if (st.profileId && cm && !profiles.some(p => p.id === st.profileId)) { st.profileId = ''; save(); } // 삭제된 프로필은 선택 안 함으로
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
    const chip = m => `<button type="button" class="gpen-btn gpen-chip ${st[MODE[m].flag] ? 'gpen-on' : ''}" data-flag="${MODE[m].flag}"><i class="fa-solid ${MODE[m].icon}"></i><span>${MODE[m].label}</span></button>`;
    const segBtn = (k, v, label) => `<button type="button" class="gpen-btn gpen-seg ${st[k] === v ? 'gpen-on' : ''}" data-seg="${k}" data-v="${v}"><span>${label}</span></button>`;
    const preset = matchPreset(st);
    const lenBtn = (v, label) => `<button type="button" class="gpen-btn gpen-seg ${preset === v ? 'gpen-on' : ''}" data-lenp="${v}"><span>${label}</span></button>`;
    const step = (k, min, max, inc, val) => `<div class="gpen-step" data-step-k="${k}" data-min="${min}" data-max="${max}" data-inc="${inc}"><button type="button" class="gpen-btn gpen-step-btn" data-d="-1"><i class="fa-solid fa-minus"></i></button><span class="gpen-step-val">${val}</span><button type="button" class="gpen-btn gpen-step-btn" data-d="1"><i class="fa-solid fa-plus"></i></button></div>`;

    root.html(`
      <div class="gpen-pop gpen-settings">
        <div class="gpen-tabs">
          <button type="button" class="gpen-tab ${curTab === 'set' ? 'on' : ''}" data-tab="set">설정</button>
          <button type="button" class="gpen-tab ${curTab === 'log' ? 'on' : ''}" data-tab="log">기록 <span class="gpen-badge">${st.logs.length}</span></button>
        </div>

        <div class="gpen-pane ${curTab === 'set' ? 'on' : ''}" data-pane="set">
          <div class="gpen-row"><button type="button" class="gpen-btn gpen-restore-btn ${lastOriginal === null ? 'gpen-dim' : ''}"><i class="fa-solid fa-rotate-left"></i><span>원문 복원</span></button></div>

          <div class="gpen-section-title">입력창 아이콘</div>
          <div class="gpen-row">${chip('first')}${chip('third')}${chip('keep')}</div>

          <div class="gpen-section-title">강도</div>
          <div class="gpen-row">${segBtn('intensity', 'weak', '약')}${segBtn('intensity', 'mid', '중')}${segBtn('intensity', 'strong', '강')}</div>

          <div class="gpen-section-title">분량</div>
          <div class="gpen-row">${lenBtn('short', '짧게')}${lenBtn('normal', '보통')}${lenBtn('long', '길게')}</div>
          <details class="gpen-adv" ${advOpen ? 'open' : ''}>
            <summary>고급</summary>
            <div class="gpen-field"><label>최소 글자 수</label>${step('minChars', 50, 6000, 50, st.minChars)}</div>
            <div class="gpen-field"><label>최대 글자 수</label>${step('maxChars', 50, 6000, 50, st.maxChars)}</div>
            <div class="gpen-field"><label>최대 출력 토큰</label>${step('maxTokens', 1000, 32000, 500, st.maxTokens)}</div>
            <div class="gpen-hint gpen-muted">글자 수는 공백을 포함하며, 권장 범위예요.</div>
          </details>

          <div class="gpen-field"><label>참고할 최근 채팅 수</label>${step('recent', 0, 50, 1, st.recent)}</div>

          <div class="gpen-section-title">생성 설정</div>
          <div class="gpen-field"><label>연결 프로필</label>
            <select class="text_pole" data-k="profileId">${opt('', '선택 안 함', st.profileId)}${profiles.map(p => opt(p.id, p.name, st.profileId)).join('')}</select></div>
          <div class="gpen-field"><label>시간 제한 (초)</label>${step('timeoutSec', 10, 600, 10, st.timeoutSec)}</div>
        </div>

        <div class="gpen-pane ${curTab === 'log' ? 'on' : ''}" data-pane="log">
          <div class="gpen-logbar">
            <span class="gpen-muted">기록은 원문과 결과 내용 없이 개수와 오류만 저장돼요. 최근 ${MAX_LOGS}건까지 보관해요.</span>
            <button type="button" class="gpen-btn gpen-clear"><i class="fa-solid fa-trash"></i><span>지우기</span></button>
          </div>
          <div class="gpen-loglist">${renderLogItems()}</div>
        </div>
      </div>`);

    root.off('.gpen');
    root.on('click.gpen', '[data-tab]', function () {
        curTab = $(this).data('tab');
        root.find('.gpen-tab').removeClass('on'); $(this).addClass('on');
        root.find('.gpen-pane').removeClass('on'); root.find(`[data-pane="${curTab}"]`).addClass('on');
    });
    root.on('click.gpen', '[data-flag]', function () {
        const s = S(); const k = $(this).data('flag');
        s[k] = !s[k]; save();
        $(this).toggleClass('gpen-on', s[k]);
        buildBar();
    });
    root.on('click.gpen', '[data-seg]', function () {
        S()[$(this).data('seg')] = $(this).data('v'); save();
        $(this).closest('.gpen-row').find('.gpen-seg').removeClass('gpen-on');
        $(this).addClass('gpen-on');
    });
    root.on('click.gpen', '[data-lenp]', function () {
        const [a, b] = LENGTH_PRESETS[$(this).data('lenp')];
        const s = S(); s.minChars = a; s.maxChars = b; save();
        syncLengthUI(root);
    });
    root.on('click.gpen', '.gpen-step-btn', function () {
        const box = $(this).closest('.gpen-step');
        const k = box.data('step-k');
        const min = Number(box.data('min')), max = Number(box.data('max')), inc = Number(box.data('inc'));
        const s = S();
        s[k] = Math.min(max, Math.max(min, (Number(s[k]) || 0) + inc * Number($(this).data('d'))));
        if (k === 'minChars' && s.minChars > s.maxChars) s.maxChars = s.minChars;
        if (k === 'maxChars' && s.maxChars < s.minChars) s.minChars = s.maxChars;
        save();
        syncLengthUI(root);
    });
    root.on('click.gpen', '.gpen-adv > summary', function () { advOpen = !$(this).parent().prop('open'); });
    root.on('change.gpen', 'select[data-k]', function () { S()[$(this).data('k')] = this.value; save(); });
    root.on('click.gpen', '.gpen-restore-btn', restoreOriginal);
    root.on('click.gpen', '.gpen-copy-one', async function () {
        const l = S().logs[Number($(this).data('i'))];
        if (!l) return;
        const t = formatLog(l);
        try { await navigator.clipboard.writeText(t); }
        catch { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
        const btn = $(this); // 복사 완료 표시
        btn.find('i').attr('class', 'fa-solid fa-check'); btn.find('span').text('복사됨');
        setTimeout(() => { btn.find('i').attr('class', 'fa-solid fa-copy'); btn.find('span').text('이 기록 복사'); }, 1500);
    });
    root.on('click.gpen', '.gpen-clear', () => { S().logs = []; save(); refreshLogViews(); });
}

async function openPopup() {
    const c = ctx();
    const wrap = $('<div class="gpen-popwrap"></div>');
    renderPanel(wrap);
    await c.callGenericPopup(wrap[0], c.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: '닫기' });
}

function addWandItem() {
    if ($('#ghostpen_wand').length) return;
    const item = $('<div id="ghostpen_wand" class="list-group-item flex-container flexGap5"><div class="extensionsMenuExtensionButton">✒️</div><span>Ghostpen</span></div>');
    item.on('click', () => { $('#extensionsMenu').hide(); openPopup(); });
    $('#extensionsMenu').append(item);
}

function addDrawer() {
    if ($('#ghostpen_drawer').length) return;
    const html = $(`<div id="ghostpen_drawer" class="extension_container"><div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header"><b>✒️ Ghostpen</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
      <div class="inline-drawer-content"><div class="gpen-drawer-body"></div></div></div></div>`);
    $('#extensions_settings2').append(html);
    const body = html.find('.gpen-drawer-body');
    renderPanel(body);
    html.find('.inline-drawer-toggle').on('click', () => renderPanel(body)); // 열 때 프로필 목록 갱신
}

jQuery(() => {
    S();
    buildBar();
    addWandItem();
    addDrawer();
    try { // 전송/채팅 변경 시 원문 삭제
        const { eventSource, event_types } = ctx();
        eventSource.on(event_types.MESSAGE_SENT, clearOriginal);
        eventSource.on(event_types.CHAT_CHANGED, clearOriginal);
    } catch { /* 무시 */ }
    let tries = 0;
    const iv = setInterval(() => { addWandItem(); if ($('#ghostpen_wand').length || ++tries > 20) clearInterval(iv); }, 1000);
});
