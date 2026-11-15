// Ghostpen v0.7.8 - SillyTavern 대필 확장 (버전을 올릴 때 이 주석과 아래 VERSION을 같이 고칠 것)
const MODULE = 'ghostpen';
const VERSION = '0.7.8';

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
    icons: {},            // 아이콘 꾸미기 (바꾼 것만 저장)
    align: 'right',       // 아이콘 줄 정렬: 'left' | 'center' | 'right'
    place: 'row',         // 'row' 입력창 위 별도 줄(기본) / 'merge' 삼줄·마법봉·전송과 한 줄
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
    `[Priority]`,
    `- If rules conflict, follow this order.`,
    `[Request] -> [Rules] -> [Description] -> [Point of view] -> [Intensity] -> [Length]`,
    ``,
    `- If a [Request] is present, it applies before every rule and section in this prompt.`,
    `- If the draft is empty, [Empty draft] applies before [Rules].`,
    ``,
    `[Rules]`,
    `- Reflect every action in the draft, and every line of dialogue inside double quotes (" "), in the original order, without omitting any. Do not change their content, order, meaning, or cause-and-effect.`,
    `- Keep every line of dialogue inside double quotes (" ") exactly as it appears in the draft. Do not change or drop any word, punctuation mark, or spacing.`,
    `- Do not add new dialogue, events, characters, or results that are not in the draft.`,
    `- Use only what is in the draft for the dialogue, actions, reactions, emotions, and sensations of {{char}} and NPCs.`,
    ``,
    `What you may supplement:`,
    `- How an existing action is carried out, sensations that fit the context, atmosphere, and detailed description`,
    `  Example: "He opened the door" -> he turned the handle and pushed the door open (allowed) / "He went out into the hallway" (forbidden).`,
    `- {{user}}'s actions, reactions, emotions, and sensations`,
    `- Concrete description of those actions, reactions, and sensations of {{char}} and NPCs that are written in the draft`,
    `- Narration that connects one line of dialogue to the next`,
    `- Narration that closes the end of the draft`,
    ``,
    `[Description]`,
    `- The amount and depth of description follow the selected intensity.`,
    `- Fix repeated information, emotions, words, and narration, spelling and spacing errors and other grammar errors, and awkward sentence connections. However, keep dialogue inside double quotes, and any part the draft explicitly says was written that way on purpose, exactly as it is.`,
    `- Describe {{user}}'s emotions, inner thoughts, and sensations only when the draft and the context support them and the selected point of view allows them.`,
    `- Make the draft concrete in line with the existing context. For a place that has already appeared, you may add light, sound, temperature, and atmosphere that suit the scene, but do not invent appearance, belongings, backstory, or new objects or places that the context does not contain.`,
    `- Use the character description, the persona, and the recent chat only to understand the context. Do not copy or summarize them, and do not retell what has already happened.`,
    `- If there is a draft, supplement the {{user}}'s emotions and sensations and the surrounding atmosphere contained in the draft's last dialogue, action, or narration, so that the scene closes naturally instead of breaking off awkwardly. Write this narration only within the draft's last scene, and do not write any new action or event that would follow it.`,
    `- Between one line of dialogue and the next, you must write at least one sentence of narration. Fill it with an action, gaze, sensation, or surrounding atmosphere that follows from the previous line, so that the lines before and after connect naturally.`,
    ``,
    `[Output]`,
    `- Output only the finished passage. Do not add reasoning, information blocks, or the like.`,
    `- Write in the same language as the draft. If the draft is empty, write in Korean.`,
    `- End any narration you newly write with a complete sentence. Dialogue inside double quotes stays exactly as in the draft, even if the sentence is unfinished.`,
    `- Even when you restructure sentences and paragraphs, separate dialogue and narration with line breaks so they do not run together on one line. Split narration into paragraphs at points where the action, gaze, emotion, or setting shifts, and do not pack several different flows into one paragraph.`,
    `- Before you output, check that the dialogue inside double quotes matches the draft and that there are no actions, reactions, emotions, or sensations of {{char}} or NPCs that are not in the draft. If anything is off, fix it.`,
].join('\n');

const PERSPECTIVE = {
    first: [
        `[Point of view: first person]`,
        `- Rewrite all narration outside double quotes from {{user}}'s first-person point of view.`,
        `- Do not narrate other characters' inner thoughts or sensations.`,
    ].join('\n'),
    third: [
        `[Point of view: third person]`,
        `- Write all narration outside double quotes in third person.`,
        `- Do not lock the point of view to any one character.`,
        `- If there is no clue for judging the point of view, narrate centered on externally observable actions, gestures, sounds, and space.`,
        `- Narrate other characters' inner thoughts or sensations only if they are in the draft.`,
    ].join('\n'),
    keep: [
        `[Point of view: no fixed person]`,
        `- Keep the draft's person and point of view exactly as they are. Even if they are mixed, do not unify or change them.`,
        `- Rewrite the narration naturally in line with the draft's person and point of view.`,
        `- Newly written narration follows the person and point of view of the sentence immediately before it.`,
        `- Narrate other characters' inner thoughts or sensations only if they are in the draft.`,
    ].join('\n'),
};

const INTENSITY = {
    weak: [
        `[Intensity: Light]`,
        `- Keep the draft's wording. However, fix spelling and spacing errors in narration outside double quotes.`,
        `- Supplement the process, sensation, and setting of actions only a little.`,
        `- Describe emotions only to the extent the draft shows them.`,
        `- Close the passage in one or two sentences.`,
    ].join('\n'),
    mid: [
        `[Intensity: Medium]`,
        `- Restructure sentences and paragraphs naturally.`,
        `- Expand the process, sensation, and setting of actions in concrete terms.`,
        `- Supplement {{user}}'s core emotion and psychology within what the context supports.`,
    ].join('\n'),
    strong: [
        `[Intensity: Strong]`,
        `- Actively restructure sentences and paragraphs.`,
        `- Expand the process, sensation, and setting of actions richly.`,
        `- Describe the flow of {{user}}'s emotion and psychology in depth, within what the context supports.`,
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
    `The user attached a request to this ghostwriting. This request takes priority over all the rules and instructions above. Where it conflicts with a rule, follow the request all the way; do not reflect only part of it or skip it because of a rule. Follow the usual rules only for what the request does not mention. Before you output, check that the request is reflected.`,
].join('\n');

function buildMessages(input, mode, st, request = '') {
    const c = ctx();
    const ch = (c.characterId !== undefined && c.characters) ? c.characters[c.characterId] : null;
    const persona = c.powerUserSettings?.persona_description || '';
    const recentN = Math.max(0, Number(st.recent) || 0); // 0이면 채팅을 보내지 않음 (slice(-0)은 전체를 가져오므로 따로 처리)
    const recent = (c.chat || []).filter(m => !m.is_system && m.mes).slice(recentN ? -recentN : Infinity)
        .map(m => `${m.name}: ${m.mes}`).join('\n\n');
    const hasInput = !!input.trim();
    const parts = [
        `[Character description: ${ch?.name || c.name2 || ''}]\n${ch?.description || '(none)'}`,
        `[Persona of {{user}}: ${c.name1 || ''}]\n${persona || '(none)'}`,
        `[Recent chat]\n${recent || '(none)'}`,
        PERSPECTIVE[mode],
        INTENSITY[st.intensity] || INTENSITY.mid,
        ...(hasInput ? [] : [EMPTY_INSTRUCTION]),
        `[Length]\n- ${st.minChars} to ${st.maxChars} characters, including spaces.\n- If there is a draft, do not add new events or dialogue.\n- Reach the length by describing in concrete detail the process, sensation, setting, atmosphere, and emotion of the actions that are already there. Do not repeat the same content.`,
        `<draft>\n${hasInput ? input : ''}\n</draft>`,
        ...(request ? [`${REQUEST_INSTRUCTION}\n<request>\n${request}\n</request>`] : []),
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
    // 숫자는 상태 코드로 나온 것만 본다 (본문 속 우연한 숫자에 속지 않도록)
    const codes = [...net.matchAll(/"code"\s*:\s*(\d{3})/g)].map(m => m[1]);
    const http = net.match(/HTTP (\d{3})/)?.[1];
    if (http) codes.push(http);
    for (const m of detail.matchAll(/\b([1-5]\d\d)\b/g)) codes.push(m[1]);
    const has = re => codes.some(c => re.test(c));
    if (has(/^429$/) || /RESOURCE_EXHAUSTED|rate limit|quota/i.test(t)) return '서버(제공사)의 사용량 한도 초과예요. 확장 문제가 아니에요. 잠시 후 다시 시도하거나 할당량/모델/지역 설정을 확인하세요.';
    if (has(/^40[13]$/) || /UNAUTHENTICATED|PERMISSION_DENIED|api key|credential/i.test(t)) return '인증 또는 권한 문제예요. API 키, 프로젝트, 권한 설정을 확인하세요.';
    if (has(/^404$/) || /NOT_FOUND/i.test(t)) return '모델 또는 지역(엔드포인트)을 찾을 수 없어요. 모델 이름과 지역 설정을 확인하세요.';
    if (has(/^400$/) || /INVALID_ARGUMENT/i.test(t)) return '요청 형식이 거절됐어요. 모델이 지원하지 않는 설정이 있을 수 있어요.';
    if (has(/^5\d\d$/) || /UNAVAILABLE|INTERNAL/i.test(t)) return '서버 쪽 오류예요. 잠시 후 다시 시도하세요.';
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
        ['length', '권장 분량'], ['source', '요청 대상'], ['api', 'API'], ['inputChars', '원문 글자수'],
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
    const onInput = () => { if (run?.id === id && ta.value !== rawText) cancelRun('입력창이 변경되어 대필을 취소해요.'); };
    const stopWatch = () => ta.removeEventListener('input', onInput);
    ta.addEventListener('input', onInput);
    const t0 = Date.now();
    const conn = resolveConnection(st);
    const log = {
        mode: MODE[mode].label, intensity: INT_LABEL[st.intensity], length: `${st.minChars}~${st.maxChars}자 / 최대 출력 ${st.maxTokens}토큰`,
        source: conn.kind === 'profile' ? `프로필: ${conn.profile?.name || '찾을 수 없음'}` : '선택 안 함 (지금 사용 중인 연결과 프리셋 그대로)',
        api: conn.profile?.api || c.mainApi || '', inputChars: input.length,
        env: `확장 v${VERSION} / ${deviceInfo()}`,
    };
    let stage = '준비';
    let netInfo = '';
    const timer = setTimeout(() => { if (run?.id === id) run.timedOut = true; controller.abort(); }, Math.max(10, st.timeoutSec) * 1000);
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
                signal: controller.signal, // 고펜 자기 요청에만 취소 신호 전달 (지원하지 않는 버전이면 무시됨)
            });
            p.catch(() => {});
            const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new DOMException('요청이 중단되었어요.', 'AbortError'))));
            res = await Promise.race([p, aborted]);
            log.cancel = '취소 신호를 보냈어요. 이 연결이 취소를 지원하지 않으면 서버 생성은 계속되고 결과만 무시해요';
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
        const quoted = request ? [] : extractQuoted(input); // 요청이 있으면 대사 변경이 의도일 수 있어 검사하지 않음
        const changed = quoted.filter(q => !out.includes(q)).length;
        if (changed) warns.push(`따옴표 안 내용 ${quoted.length}개 중 ${changed}개가 원문과 달라요.`);

        stopWatch(); // 결과를 넣을 때 생기는 입력 이벤트로 취소되지 않게
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
        toastr.error('👻 펜 뽀려요 대필 실패 ! 👻')?.css({ 'border-radius': '14px', 'background-color': 'var(--SmartThemeBlurTintColor)', 'background-image': 'none', color: 'var(--SmartThemeBodyColor)', border: '1px solid var(--SmartThemeBorderColor)' });
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
        stopWatch();
        clearTimeout(timer);
        if (run && run.id === id) { run = null; setBusy(mode, false); }
    }
}

function cancelRun(reason) { // 진행 중인 대필을 즉시 취소. reason이 있으면 토스트로 이유를 알림
    if (!run) return;
    const m = run.mode;
    run.cancelled = true; run.controller.abort(); run = null; setBusy(m, false);
    if (reason) { try { window.toastr?.info(reason); } catch { /* 무시 */ } }
}
function onIconClick(mode) {
    if (run) { if (run.mode === mode) cancelRun(); return; } // 같은 아이콘을 다시 누르면 취소 (알림 없음)
    runGhostpen(mode);
}
function setBusy(mode, busy) {
    $('#ghostpen_bar').toggleClass('gpen-busy', busy);
    $('#ghostpen_bar .gpen-icon[data-mode]').each(function () {
        const m = $(this).data('mode');
        const active = busy && m === mode;
        $(this).toggleClass('gpen-active', active);
        $(this).html(iconInner(m, active));
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


/* 아이콘 꾸미기 */
const ICON_KEYS = ['first', 'third', 'keep', 'restore'];
const ICON_DEF = { kind: 'default', emoji: '', img: '', size: 32, color: '', bcolor: '', shape: 'default' };
const SHAPES = { default: '기본', round: '원', square: '네모', none: '없음' };
const iconMeta = k => k === 'restore' ? { label: '복원', icon: 'fa-rotate-left' } : MODE[k];
const ic = k => ({ ...ICON_DEF, ...(S().icons?.[k] || {}) });
function setIc(k, patch) { const s = S(); if (!s.icons) s.icons = {}; s.icons[k] = { ...ic(k), ...patch }; save(); }
const safeColor = c => /^#[0-9a-f]{6}$/i.test(c || '') ? c : '';
const safeSrc = u => /^(https?:\/\/|data:image\/|\/(?!\/))/i.test(u || '') ? u : ''; // //host/ 형태는 외부 주소라 막음
function iconInner(k, spin = false) {
    const c = ic(k);
    const sz = Math.min(64, Math.max(20, Number(c.size) || 32));
    if (!spin && c.kind === 'emoji' && c.emoji) return `<span class="gpen-emo" style="font-size:${Math.round(sz * 0.55)}px">${esc(c.emoji)}</span>`;
    if (!spin && c.kind === 'image' && safeSrc(c.img)) return `<img src="${esc(c.img)}" alt="">`;
    const col = c.kind === 'default' && safeColor(c.color) ? `color:${c.color};opacity:1;` : '';
    const fs = sz !== 32 ? `font-size:${Math.round(sz * 0.5)}px;` : '';
    return `<i class="fa-solid ${spin ? 'fa-spinner fa-spin' : iconMeta(k).icon}"${fs || col ? ` style="${fs}${col}"` : ''}></i>`;
}
function iconStyle(k) {
    const c = ic(k);
    const sz = Math.min(64, Math.max(20, Number(c.size) || 32));
    let css = ''; // 바꾼 값만 적용 (기본값이면 인라인 스타일 없음 → 사용자 CSS가 그대로 먹음)
    if (sz !== 32) css += `width:${sz}px;height:${sz}px;font-size:${Math.round(sz * 0.5)}px;`;
    if (c.kind === 'default' && safeColor(c.color)) css += `color:${c.color};`;
    if (c.shape === 'none') css += 'border:none;background:transparent;';
    else {
        if (safeColor(c.bcolor)) css += `border-color:${c.bcolor};`;
        if (c.shape === 'round') css += 'border-radius:50%;';
        else if (c.shape === 'square') css += 'border-radius:0;';
    }
    return css;
}
function fileToIcon(file) { // 올린 이미지를 작게 줄여 저장
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onerror = reject;
        fr.onload = () => {
            const img = new Image();
            img.onerror = reject;
            img.onload = () => {
                const iw = img.naturalWidth || 96, ih = img.naturalHeight || 96;
                const r = Math.min(1, 96 / Math.max(iw, ih));
                const cv = document.createElement('canvas');
                cv.width = Math.max(1, Math.round(iw * r)); cv.height = Math.max(1, Math.round(ih * r));
                cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
                resolve(cv.toDataURL('image/png'));
            };
            img.src = fr.result;
        };
        fr.readAsDataURL(file);
    });
}
const alignOf = st => ['left', 'center'].includes(st.align) ? st.align : 'right';
const hex2rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = (r, g, b) => '#' + [r, g, b].map(v => Math.min(255, Math.max(0, Math.round(Number(v) || 0))).toString(16).padStart(2, '0')).join('');
function themeRGB(cssVar) { // 테마 기본색을 RGB로 읽기
    const el = document.createElement('span');
    el.style.color = `var(${cssVar})`;
    document.body.appendChild(el);
    const m = getComputedStyle(el).color.match(/\d+(\.\d+)?/g);
    el.remove();
    return m && m.length >= 3 ? m.slice(0, 3).map(n => Math.round(Number(n))) : [200, 200, 200];
}
const decoColorOpen = {};
let decoSel = 'first';
let decoOpen = false;
function decoHtml() {
    const c = ic(decoSel);
    const seg = (attr, v, label, cur) => `<button type="button" class="gpen-btn gpen-seg ${cur === v ? 'gpen-on' : ''}" data-${attr}="${v}"><span>${label}</span></button>`;
    const sels = ICON_KEYS.map(k => seg('dsel', k, iconMeta(k).label, decoSel)).join('');
    const colorRow = (key, label, val) => {
        const set = safeColor(val);
        const [r, g, b] = set ? hex2rgb(set) : themeRGB(key === 'color' ? '--SmartThemeBodyColor' : '--SmartThemeBorderColor');
        const ch = [r, g, b].map((v, i) => `<div class="gpen-chrow"><b>${'RGB'[i]}</b><input type="range" min="0" max="255" step="1" class="gpen-rng gpen-rng-${'rgb'[i]}" data-drgb="${key}" value="${v}"><input type="number" inputmode="numeric" min="0" max="255" class="text_pole gpen-rgb" data-drgb="${key}" value="${v}"></div>`).join('');
        return `<details class="gpen-colorfold" data-k="${key}" ${decoColorOpen[key] ? 'open' : ''}><summary><span class="gpen-swatch" style="background:${rgb2hex(r, g, b)}"></span><span>${label}</span><span class="gpen-fold-state">${set ? `RGB ${r}, ${g}, ${b}` : '기본색'}</span></summary><div class="gpen-colorrow">${ch}<div class="gpen-colortop"><button type="button" class="gpen-btn" data-dcolor-reset="${key}"><span>${set ? '기본색으로' : '기본색 사용 중'}</span></button></div></div></details>`;
    };
    let kindBody = '';
    if (c.kind === 'emoji') {
        kindBody = `<div class="gpen-field"><input type="text" class="text_pole" data-dtext maxlength="8" placeholder="이모지 입력 (예: 💀)" value="${esc(c.emoji)}"></div>`;
    } else if (c.kind === 'image') {
        const isData = String(c.img).startsWith('data:');
        kindBody = `<div class="gpen-field"><input type="text" class="text_pole" data-dimg placeholder="${isData ? '올린 이미지를 쓰는 중이에요' : '이미지 주소 (https://...)'}" value="${isData ? '' : esc(c.img)}">
            <div class="gpen-row"><button type="button" class="gpen-btn" data-dupload><i class="fa-solid fa-upload"></i><span>기기에서 올리기</span></button></div>
            <input type="file" accept="image/*" data-dfile style="display:none"></div>`;
    }
    return `
      <div class="gpen-row">${sels}</div>
      <div class="gpen-deco-preview"><div class="gpen-icon" style="${iconStyle(decoSel)}cursor:default">${iconInner(decoSel)}</div></div>
      <div class="gpen-field"><label>모양</label><div class="gpen-row">${seg('dkind', 'default', '기본', c.kind)}${seg('dkind', 'emoji', '이모지', c.kind)}${seg('dkind', 'image', '이미지', c.kind)}</div>${kindBody}</div>
      <div class="gpen-field"><label>크기 (px)</label><div class="gpen-dstep"><button type="button" class="gpen-btn gpen-dstep-btn" data-dd="-1"><i class="fa-solid fa-minus"></i></button><span class="gpen-step-val">${Math.min(64, Math.max(20, Number(c.size) || 32))}</span><button type="button" class="gpen-btn gpen-dstep-btn" data-dd="1"><i class="fa-solid fa-plus"></i></button></div></div>
      ${c.kind === 'default' ? colorRow('color', '아이콘 색', c.color) : ''}
      <div class="gpen-field"><label>테두리 모양</label><div class="gpen-row">${Object.entries(SHAPES).map(([v, l]) => seg('dshape', v, l, c.shape)).join('')}</div></div>
      ${c.shape !== 'none' ? colorRow('bcolor', '테두리 색', c.bcolor) : ''}
      <div class="gpen-row"><button type="button" class="gpen-btn" data-dreset><i class="fa-solid fa-rotate-left"></i><span>이 아이콘 기본값</span></button><button type="button" class="gpen-btn" data-dresetall><i class="fa-solid fa-trash-arrow-up"></i><span>전부 기본값 복원</span></button></div>`;
}

/* UI */
function buildBar() {
    $('#send_form').removeClass('gpen-inline gpen-merge');
    const st = S();
    let bar = $('#ghostpen_bar');
    bar.children('.gpen-icon').remove(); // 우리 아이콘만 교체 (다른 확장이 줄 안에 붙인 것은 지우지 않음)
    const active = Object.entries(MODE).filter(([, v]) => st[v.flag]);
    if (!active.length) { // 아이콘을 모두 끄면 숨김
        if (bar.length && !bar.children().length) bar.remove();
        updateRestoreUI(); return;
    }
    if (!bar.length) bar = $('<div id="ghostpen_bar"></div>');
    const icons = $('<div></div>');
    $(`<div class="gpen-icon gpen-restore" title="원문 복원" style="${iconStyle('restore')}">${iconInner('restore')}</div>`).on('click', restoreOriginal).appendTo(icons);
    for (const [k, v] of active) {
        $(`<div class="gpen-icon" data-mode="${k}" title="${v.label}" style="${iconStyle(k)}">${iconInner(k)}</div>`)
            .on('click', () => onIconClick(k)).appendTo(icons);
    }
    bar.prepend(icons.children());
    bar.removeClass('gpen-al-left gpen-al-center gpen-al-right').addClass(`gpen-al-${alignOf(st)}`);
    const rightForm = $('#rightSendForm');
    const nonQR = $('#nonQRFormItems');
    if (st.place === 'merge' && rightForm.length) { // 같이: 입력창 묶음 안 (전송 버튼 앞)
        rightForm.before(bar);
        $('#send_form').addClass('gpen-merge');
    } else if (nonQR.length) nonQR.before(bar); else $('#send_form').prepend(bar); // 따로: 입력창 위 별도 줄
    if (run) setBusy(run.mode, true); // 대필 중에 아이콘이 다시 그려져도 취소할 수 있게 상태 복원
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

          <div class="gpen-section-title">아이콘</div>
          <div class="gpen-row">${chip('first')}${chip('third')}${chip('keep')}</div>
          <div class="gpen-field"><label>위치</label>
            <div class="gpen-row"><button type="button" class="gpen-btn gpen-seg ${st.place !== 'merge' ? 'gpen-on' : ''}" data-dplace="row"><span>따로</span></button><button type="button" class="gpen-btn gpen-seg ${st.place === 'merge' ? 'gpen-on' : ''}" data-dplace="merge"><span>같이</span></button></div></div>
          <div class="gpen-field"><label>정렬</label>
            <div class="gpen-row">${[['left', '왼쪽'], ['center', '가운데'], ['right', '오른쪽']].map(([v, l]) => `<button type="button" class="gpen-btn gpen-seg ${alignOf(st) === v ? 'gpen-on' : ''}" data-dalign="${v}"><span>${l}</span></button>`).join('')}</div></div>
          <details class="gpen-deco" ${decoOpen ? 'open' : ''}>
            <summary>아이콘 꾸미기</summary>
            <div class="gpen-deco-body">${decoHtml()}</div>
          </details>

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
    const refreshDeco = () => root.find('.gpen-deco-body').html(decoHtml());
    const refreshPreview = () => root.find('.gpen-deco-preview .gpen-icon').attr('style', iconStyle(decoSel) + 'cursor:default').html(iconInner(decoSel));
    const warn = msg => { try { window.toastr?.warning(msg); } catch { /* 무시 */ } };
    root.on('click.gpen', '.gpen-deco > summary', function () { decoOpen = !$(this).parent().prop('open'); });
    root.on('click.gpen', '.gpen-colorfold > summary', function () { const d = $(this).parent(); decoColorOpen[d.data('k')] = !d.prop('open'); });
    root.on('click.gpen', '[data-dplace]', function () {
        S().place = $(this).data('dplace'); save(); buildBar();
        root.find('[data-dplace]').each(function () { $(this).toggleClass('gpen-on', $(this).data('dplace') === (S().place === 'merge' ? 'merge' : 'row')); });
    });
    root.on('click.gpen', '[data-dalign]', function () {
        S().align = $(this).data('dalign'); save(); buildBar();
        root.find('[data-dalign]').each(function () { $(this).toggleClass('gpen-on', $(this).data('dalign') === alignOf(S())); });
    });
    root.on('click.gpen', '[data-dsel]', function () { decoSel = $(this).data('dsel'); refreshDeco(); });
    root.on('click.gpen', '[data-dkind]', function () { setIc(decoSel, { kind: $(this).data('dkind') }); buildBar(); refreshDeco(); });
    root.on('click.gpen', '[data-dshape]', function () { setIc(decoSel, { shape: $(this).data('dshape') }); buildBar(); refreshDeco(); });
    root.on('click.gpen', '.gpen-dstep-btn', function () {
        const c = ic(decoSel);
        const size = Math.min(64, Math.max(20, (Number(c.size) || 32) + 2 * Number($(this).data('dd'))));
        setIc(decoSel, { size });
        $(this).closest('.gpen-dstep').find('.gpen-step-val').text(size);
        buildBar(); refreshPreview();
    });
    root.on('input.gpen', '[data-dtext]', function () { setIc(decoSel, { emoji: this.value.trim() }); buildBar(); refreshPreview(); });
    root.on('change.gpen', '[data-dimg]', function () {
        const u = this.value.trim();
        if (u && !safeSrc(u)) { warn('이미지 주소는 http(s)://로 시작해야 해요.'); return; }
        if (!u && String(ic(decoSel).img).startsWith('data:')) return; // 올린 이미지는 빈칸으로 지워지지 않게
        setIc(decoSel, { img: u }); buildBar(); refreshPreview();
    });
    root.on('click.gpen', '[data-dupload]', function () { root.find('[data-dfile]').trigger('click'); });
    root.on('change.gpen', '[data-dfile]', async function () {
        const f = this.files?.[0]; this.value = '';
        if (!f) return;
        if (f.size > 5 * 1024 * 1024) { warn('5MB 이하 이미지만 쓸 수 있어요.'); return; }
        try { setIc(decoSel, { img: await fileToIcon(f) }); buildBar(); refreshDeco(); }
        catch { warn('이미지를 불러오지 못했어요.'); }
    });
    root.on('input.gpen', '.gpen-rgb, .gpen-rng', function () {
        const row = $(this).closest('.gpen-colorrow');
        const line = $(this).closest('.gpen-chrow');
        if (this.type === 'range') line.find('.gpen-rgb').val(this.value);
        else if (this.value !== '') line.find('.gpen-rng').val(Math.min(255, Math.max(0, Number(this.value) || 0)));
        const vals = row.find('.gpen-rgb').map((i, e) => e.value).get();
        if (vals.some(v => v === '')) return;
        const hex = rgb2hex(...vals);
        setIc(decoSel, { [$(this).data('drgb')]: hex });
        const fold = $(this).closest('.gpen-colorfold');
        fold.find('.gpen-swatch').css('background', hex);
        fold.find('.gpen-fold-state').text(`RGB ${vals.map(v => Math.min(255, Math.max(0, Math.round(Number(v) || 0)))).join(', ')}`);
        row.find('[data-dcolor-reset] span').text('기본색으로');
        buildBar(); refreshPreview();
    });
    root.on('change.gpen', '.gpen-rgb', function () {
        this.value = Math.min(255, Math.max(0, Math.round(Number(this.value) || 0)));
        $(this).trigger('input');
    });
    root.on('click.gpen', '[data-dcolor-reset]', function () { setIc(decoSel, { [$(this).data('dcolor-reset')]: '' }); buildBar(); refreshDeco(); });
    root.on('click.gpen', '[data-dreset]', function () { const s = S(); if (s.icons) delete s.icons[decoSel]; save(); buildBar(); refreshDeco(); });
    root.on('click.gpen', '[data-dresetall]', function () {
        if (!window.confirm('모든 아이콘을 기본값으로 되돌릴까요?')) return;
        S().icons = {}; save(); buildBar(); refreshDeco();
    });
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
        eventSource.on(event_types.MESSAGE_SENT, () => { cancelRun('메시지가 전송되어 대필을 취소해요.'); clearOriginal(); });
        eventSource.on(event_types.CHAT_CHANGED, () => { cancelRun('채팅이 변경되어 대필을 취소해요.'); clearOriginal(); });
    } catch { /* 무시 */ }
    let tries = 0;
    const iv = setInterval(() => { addWandItem(); if ($('#ghostpen_wand').length || ++tries > 20) clearInterval(iv); }, 1000);
});
