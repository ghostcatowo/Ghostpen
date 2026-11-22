// Ghostpen v0.8.13 - SillyTavern 대필 확장 (버전을 올릴 때 이 주석과 아래 VERSION 두 곳을 같이 고칠 것)
const MODULE = 'ghostpen';
const VERSION = '0.8.13';
// 레이아웃을 추가할 때 고칠 곳: 여기 / buildBar의 레이아웃 분기와 클래스 지우기 / 설정 화면의 레이아웃 버튼 목록 / style.css의 #send_form.gpen-<값> 규칙
const LAYOUTS = ['row', 'custom', 'ded1', 'ded2']; // 레이아웃 값 목록: row 기본 / custom 커스텀 / ded1 전용1(비행기 윗줄) / ded2 전용2(비행기 아랫줄). 목록에 없는 값은 'row'로 처리

const LENGTH_PRESETS = { short: [300, 500], normal: [500, 800], long: [800, 1200] }; // 글자 수 (공백 포함)
const INT_LABEL = { weak: '약', mid: '중', strong: '강' };
// 시점을 추가할 때 고칠 곳: 여기 MODE / DEFAULTS의 flag 키 / 설정 화면의 시점 버튼(chip 목록) / 아이콘 꾸미기 선택 줄(decoHtml) / 클릭 처리(onIconClick)
const MODE = {
    first: { label: '1인칭', icon: 'fa-user', flag: 'showFirst' },
    third: { label: '3인칭', icon: 'fa-users', flag: 'showThird' },
    keep:  { label: '고정X', icon: 'fa-ghost', flag: 'showKeep' },
    character: { label: '캐릭터', icon: 'fa-feather-pointed', flag: 'showCharacter' }, // 초안을 방향 지시로 주입해 채팅 모델이 응답 (고펜 프롬프트·강도·분량 안 씀)
    unified: { label: '올인원', icon: 'fa-layer-group', flag: 'showUnified' }, // 고른 시점(unifiedPick)으로 대필 (캐릭터도 고를 수 있음)
};
const DEFAULTS = {
    showFirst: true, showThird: true, showKeep: true,
    showUnified: false,
    showCharacter: true,
    unifiedPick: 'first',
    intensity: 'mid',     // weak | mid | strong
    minChars: 500, maxChars: 800,
    maxTokens: 5000,      // 출력 토큰 상한
    recent: 5,
    profileId: '',        // '' = 선택 안 함
    timeoutSec: 120,
    sendDir: 'on',        // 방향 지시: 전송한 메시지의 // 줄을 캐릭터 반응 지시로 쓸지 (on | off)
    logs: [],
    icons: {},            // 아이콘 꾸미기 (바꾼 것만 저장)
    align: 'right',       // 아이콘 줄 정렬: 'left' | 'center' | 'right'
    place: 'row',         // 아이콘 줄 레이아웃 (LAYOUTS 참고)
};
const MAX_LOGS = 20;
let curTab = 'set';
let lenOpen = false, dirOpen = false, genOpen = false; // 설정 접이식 칸 펼침 상태: lenOpen = 글자 수 / dirOpen = 방향 지시 / genOpen = 생성 옵션
let lastOriginal = null; // 직전 원문 (메모리에만 보관)
let origKind = ''; // 원문의 종류: 'ghost'(대필) | 'char'(캐릭터) | 'dir'(방향 지시). char·dir 원문은 전송·생성 시작으로 지우지 않고, 응답이 온 뒤 그다음 새 응답이 올 때 지움 (dir은 스와이프·재생성을 응답으로 세지 않음)
let respSeen = 0; // (예비) 응답 위치 번호를 못 받는 환경에서만 쓰는 응답 수
let firstRespIdx = -1; // char·dir 원문에 대한 첫 응답이 들어갈 채팅 위치. 이 위치(와 그 스와이프·재생성·중복 신호)는 세지 않고, 그보다 뒤에 새 응답이 오면 지움

const ctx = () => SillyTavern.getContext();
function S() {
    const es = ctx().extensionSettings;
    if (!es[MODULE]) es[MODULE] = {};
    const st = es[MODULE];
    if (st.minChars === undefined) { // 구버전(단어 수 기준) 설정을 글자 수로 변환
        const OLD_WORDS = { short: [60, 100], normal: [130, 200], long: [230, 350] };
        const byLength = { short: 'short', medium: 'normal', long: 'long' }[st.length];
        const byWords = Object.entries(OLD_WORDS).find(([, [x, y]]) => x === st.minWords && y === st.maxWords)?.[0];
        const key = byLength || byWords;
        if (key) { st.minChars = LENGTH_PRESETS[key][0]; st.maxChars = LENGTH_PRESETS[key][1]; }
        else if (st.minWords && st.maxWords) { st.minChars = Math.round(st.minWords * 4 / 50) * 50; st.maxChars = Math.round(st.maxWords * 4 / 50) * 50; }
    }
    for (const k of Object.keys(DEFAULTS)) if (st[k] === undefined) st[k] = structuredClone(DEFAULTS[k]);
    if (!LAYOUTS.includes(st.place)) st.place = 'row'; // 없어진 레이아웃 값은 기본으로
    if (st.maxTokens === 4096) st.maxTokens = 5000; // 구 기본값(4096)을 새 기본값으로
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
    `- Reflect every action in the draft, and every line of dialogue inside double quotes (" ") or curly double quotes (“ ”), in the original order, without omitting any. Do not change their content, order, meaning, or cause-and-effect.`,
    `- Keep every line of dialogue inside double quotes (" ") or curly double quotes (“ ”) exactly as it appears in the draft. Do not change or drop any word, punctuation mark, or spacing.`,
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
    `- Fix repeated information, emotions, words, and narration, spelling and spacing errors and other grammar errors, and awkward sentence connections. However, keep dialogue inside double or curly double quotes, and any part the draft explicitly says was written that way on purpose, exactly as it is.`,
    `- Describe {{user}}'s emotions, inner thoughts, and sensations only when the draft and the context support them and the selected point of view allows them.`,
    `- Make the draft concrete in line with the existing context. For a place that has already appeared, you may add light, sound, temperature, and atmosphere that suit the scene, but do not invent appearance, belongings, backstory, or new objects or places that the context does not contain.`,
    `- Use the character description, the persona, and the recent chat only to understand the context. Do not copy or summarize them, and do not retell what has already happened.`,
    `- If there is a draft, supplement the {{user}}'s emotions and sensations and the surrounding atmosphere contained in the draft's last dialogue, action, or narration, so that the scene closes naturally instead of breaking off awkwardly. Write this narration only within the draft's last scene, and do not write any new action or event that would follow it.`,
    `- Between one line of dialogue and the next, you must write at least one sentence of narration. Fill it with an action, gaze, sensation, or surrounding atmosphere that follows from the previous line, so that the lines before and after connect naturally.`,
    ``,
    `[Output]`,
    `- Output only the finished passage. Do not add reasoning, information blocks, or the like.`,
    `- Write in the same language as the draft. If the draft is empty, write in Korean.`,
    `- End any narration you newly write with a complete sentence. Dialogue inside double or curly double quotes stays exactly as in the draft, even if the sentence is unfinished.`,
    `- Even when you restructure sentences and paragraphs, separate dialogue and narration with line breaks so they do not run together on one line. Split narration into paragraphs at points where the action, gaze, emotion, or setting shifts, and do not pack several different flows into one paragraph.`,
    `- Before you output, check that the dialogue inside double or curly double quotes matches the draft and that there are no actions, reactions, emotions, or sensations of {{char}} or NPCs that are not in the draft. If anything is off, fix it.`,
].join('\n');

const PERSPECTIVE = {
    first: [
        `[Point of view: first person]`,
        `- Rewrite all narration outside double or curly double quotes from {{user}}'s first-person point of view.`,
        `- Do not narrate other characters' inner thoughts or sensations.`,
    ].join('\n'),
    third: [
        `[Point of view: third person]`,
        `- Write all narration outside double or curly double quotes in third person.`,
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
        `- Keep the draft's wording. However, fix spelling and spacing errors in narration outside double or curly double quotes.`,
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

// 캐릭터·방향 지시(// 줄)이 같이 쓰는, 채팅 모델에게 임시로 끼워 넣는 안내문 (고펜 시스템/사용자 프롬프트와 별개)
const CHARACTER_DIRECTION = [
    `[Response direction]`,
    `- Treat the <direction> as the development guideline for this response, and reflect every stated action, line of dialogue, event, emotion, and mood without omitting any.`,
    `- Interpret the <direction> in the output language specified in the existing instructions, regardless of the input language. All dialogue and narration, including the dialogue stated in the <direction>, are written in that output language while keeping their meaning and tone; the response length, writing style, narrative approach, and output format also follow the existing instructions.`,
    `- Arrange the scene in a natural order that fits the overall context and cause-and-effect, but where a time order is clearly given, follow it as it is.`,
    `- If the <direction> specifies a scene, time, place, or situation different from the previous scene, switch the development to the specified content rather than continuing the previous scene. Naturally supplement the connecting narration needed for the transition, but do not linger in the previous scene or alter or omit the specified scene.`,
    `- While keeping the intent and core of the given content, compose it naturally to fit each character's personality, speech style, relationships, and the flow of previous responses.`,
    `- Give the <direction> priority over any existing rule against writing {{user}}'s actions or dialogue. If {{user}}'s actions or dialogue are included, reflect them in this response.`,
    `- Supplement the details and connecting steps that are not stated so that they fit the existing context and cause-and-effect. Do not contradict established facts or characters' personalities.`,
    `- After reflecting all the content to be developed, continue the scene through the characters' natural reactions, follow-up actions, and dialogue, and lead into the next interaction. Do not end the response mechanically at the last sentence or close the scene on your own.`,
    `- Even if the input is written as an instruction or a summary, do not explain or summarize it; carry it out as the actual actions, dialogue, and narration of the characters.`,
    `- Do not mention the existence of the <direction> or related instructions within the scene.`,
].join('\n');
const CHARACTER_LANG_CHECK = [
    `[Language check]`,
    `Respond in the output language specified in the existing instructions, not in the language of the <direction>.`,
].join('\n');

const directionText = d => `${CHARACTER_DIRECTION}\n\n<direction>\n${d}\n</direction>\n\n${CHARACTER_LANG_CHECK}`;

// 캐릭터: 빈 초안일 때는 방향 지시 대신 이 안내문을 끼워 넣는다 (캐릭터가 먼저 능동적으로 전개)
const CHARACTER_INITIATIVE_HEADER = `[{{char}}'s POV]`;
const CHARACTER_INITIATIVE = [
    CHARACTER_INITIATIVE_HEADER,
    `- From {{char}}'s POV, continue the current scene without merely reacting to the most recent input or repeating content and dialogue that have already been described.`,
    `- {{char}} does not merely react passively to the situation; according to their own personality and judgment, they act proactively and take the lead in conversation and interaction.`,
    `- Keep {{char}}'s personality, speech style, relationships, and emotional state consistent.`,
    `- Stay within the existing context and situation, and do not force new events or expand the development excessively.`,
    `- Do not make up {{user}}'s actions, dialogue, emotions, thoughts, or reactions on your own.`,
    `- The response length, writing style, narrative approach, output format, and output language follow the existing instructions.`,
    `- Do not end the response mechanically at the last sentence or close the scene on your own; lead into the next interaction.`,
    `- Do not mention the existence of these instructions within the scene.`,
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
// 큰따옴표 안의 내용만 보존 대상
function extractQuoted(text) {
    return text.match(/"[^"\n]+"|“[^”\n]+”/g) || [];
}

function explainError(detail, timedOut = false) {
    if (timedOut) return ''; // 시간 초과 문구의 숫자(예: 500초)를 상태 코드로 오해하지 않도록
    const t = detail;
    // 숫자는 HTTP 429, status: 500, "code": 429 처럼 상태 코드로 표시된 것만 본다 (문장 속 우연한 숫자 제외)
    const codes = [];
    for (const m of detail.matchAll(/(?:HTTP|status(?: code)?|code)\W{0,3}([1-5]\d\d)\b/gi)) codes.push(m[1]);
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
        ['inject', '주입 경로'], ['trigger', '생성 시작'], ['prompt', '프롬프트 확인'], ['chat', '채팅 변화'], ['end', '종료'], ['cause', '상세 원인(cause)'], ['elapsed', '경과 시간'], ['env', '환경']];
    for (const [k, label] of map) if (l[k] !== undefined && l[k] !== '' && !(k === 'reason' && l.level !== 'fail')) lines.push(`  ${label}: ${l[k]}`); // 진단 기록은 원인이 제목과 같아 생략
    return lines.join('\n');
}
function renderLogItems() {
    const logs = S().logs;
    if (!logs.length) return '<div class="gpen-empty gpen-muted">기록이 없어요.</div>';
    return logs.map((l, i) => `<details class="gpen-log ${l.level === 'warn' ? 'warn' : l.level === 'info' ? 'info' : 'fail'}"><summary>${esc(l.time)} · ${esc(l.reason || l.result)}</summary><div class="gpen-logbody"><button type="button" class="gpen-btn gpen-copy-one" data-i="${i}"><i class="fa-solid fa-copy"></i><span>이 기록 복사</span></button><pre>${esc(formatLog(l))}</pre></div></details>`).join('');
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
    const pick = mode === 'unified' ? (PERSPECTIVE[st.unifiedPick] ? st.unifiedPick : 'first') : mode;
    const { draft: input, request } = splitRequest(rawText);
    const id = ++runCounter;
    const controller = new AbortController();
    run = { id, controller, mode, cancelled: false, timedOut: false };
    setBusy(mode, true);
    const onInput = () => { if (run?.id === id && ta.value !== rawText) cancelRun(); };
    // 전송할 때 ST가 입력창을 코드로 비우면 입력 신호가 안 올 수 있어서, 대필 중에만 0.25초마다 값을 비교한다
    const poll = setInterval(() => {
        if (run?.id !== id) return;
        if (ta.value !== rawText) cancelRun();
    }, 250);
    const stopWatch = () => { ta.removeEventListener('input', onInput); clearInterval(poll); };
    ta.addEventListener('input', onInput);
    const t0 = Date.now();
    const conn = resolveConnection(st);
    const log = {
        mode: mode === 'unified' ? `${MODE.unified.label} (${MODE[pick].label})` : MODE[mode].label, intensity: INT_LABEL[st.intensity], length: `${st.minChars}~${st.maxChars}자 / 최대 출력 ${st.maxTokens}토큰`,
        source: conn.kind === 'profile' ? `프로필: ${conn.profile?.name || '찾을 수 없음'}` : '선택 안 함 (지금 사용 중인 연결과 프리셋 그대로)',
        api: conn.profile?.api || c.mainApi || '', inputChars: input.length,
        env: `확장 v${VERSION}`,
    };
    let stage = '준비';
    const timer = setTimeout(() => { if (run?.id === id) run.timedOut = true; controller.abort(); }, Math.max(10, st.timeoutSec) * 1000);
    try {
        if (conn.missing) throw new Error('선택한 연결 프로필을 찾을 수 없어요. 프로필이 삭제됐을 수 있어요. 설정에서 다시 고르거나 "선택 안 함"으로 바꿔 주세요.');
        const messages = buildMessages(input, pick, st, request);
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
                ? '응답이 비어 있어요. 출력 토큰 상한에 걸렸을 수 있어요. 추론 모델은 생각에도 토큰을 쓰니 생성 옵션에서 최대 출력 토큰을 늘려 보세요.'
                : '응답이 비어 있어요.');
        }

        // 결과는 항상 입력창에 넣고 경고만 기록
        const warns = [];
        if (/length|max_tokens/i.test(finish)) warns.push('결과가 출력 길이 상한에서 잘렸을 수 있어요.');
        const quoted = request ? [] : extractQuoted(input); // 요청이 있으면 대사 변경이 의도일 수 있어 검사하지 않음
        const changedList = quoted.filter(q => !out.includes(q));
        if (changedList.length) { // 어떤 대사가 달라졌는지 앞부분만 짧게 보여 줌 (최대 5개, 한 개당 30자)
            const cut = q => q.length > 30 ? `${q.slice(0, 30)}…` : q;
            const shown = changedList.slice(0, 5).map(cut).join(' ');
            const more = changedList.length > 5 ? ` 외 ${changedList.length - 5}개` : '';
            warns.push(`따옴표 안 내용 ${quoted.length}개 중 ${changedList.length}개가 원문과 달라요. 달라진 것: ${shown}${more}`);
        }

        stopWatch(); // 결과를 넣을 때 생기는 입력 이벤트로 취소되지 않게
        lastOriginal = rawText; origKind = 'ghost'; // 요청 줄까지 포함해서 보관
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
        failToast('👻 펜 뽀려요 대필 실패 ! 👻');
        const detail = timedOut ? `${st.timeoutSec}초 안에 응답이 오지 않았어요.` : String(e?.message || e).slice(0, 600);
        addLog({
            level: 'fail', result: '❌ 실패', stage,
            reason: timedOut ? '시간 초과' : (e?.name || 'Error'),
            detail,
            hint: explainError(detail, !!timedOut),
            cause: e?.cause ? String(e.cause?.message || e.cause).slice(0, 300) : '',
            ...log, elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}초`,
        });
    } finally {
        stopWatch();
        clearTimeout(timer);
        if (run && run.id === id) { run = null; setBusy(mode, false); }
    }
}

function cancelRun() { // 진행 중인 대필·캐릭터를 즉시 취소 (알림 없음)
    if (!run) return;
    const m = run.mode;
    run.cancelled = true;
    if (run.char) { // 채팅 모델 생성은 ST의 중지를 부르고, 입력칸이 비어 있으면 초안을 되돌림
        run = null; setBusy(m, false);
        diagFinish('취소'); stopChatGeneration(); clearDirection(); restoreIfEmpty();
        return;
    }
    run.controller.abort(); run = null; setBusy(m, false);
}
const cancelGhost = () => { if (run && !run.char) cancelRun(); }; // 전송·채팅 변경 때는 고펜 대필만 취소

/* 방향 지시 주입 (캐릭터와 방향 지시가 같이 씀): 안내문을 채팅 모델 프롬프트에 임시로 끼운다. 캐릭터는 여기에 응답 생성 시작까지 맡음 */
const DIR_KEY = 'gpen_direction';
let dirOn = false;
function failToast(msg) {
    toastr.error(msg)?.css({ 'border-radius': '14px', 'background-color': 'var(--SmartThemeBlurTintColor)', 'background-image': 'none', color: 'var(--SmartThemeBodyColor)', border: '1px solid var(--SmartThemeBorderColor)' });
}
let pendingDir = null; // 채팅 완성: 프롬프트가 만들어지는 순간 맨 끝에 붙일 방향 지시 (붙이면 비움)
const dirEvent = () => ctx().event_types?.CHAT_COMPLETION_PROMPT_READY;
function dirUnhook() { try { const es = ctx().eventSource; (es.removeListener || es.off).call(es, dirEvent(), dirHook); } catch { /* 무시 */ } }
function dirHook(data) { // 모델로 보내기 직전의 프롬프트 맨 끝에 유저 메시지로 한 번만 추가
    if (!pendingDir || data?.dryRun || !Array.isArray(data?.chat)) return;
    data.chat.push({ role: 'user', content: pendingDir });
    pendingDir = null; dirUnhook();
    diagPrompt(data); // 붙인 뒤의 프롬프트로 진단
}
async function setDirection(text) {
    const c = ctx();
    if (c.mainApi === 'openai' && dirEvent() && c.eventSource) {
        dirUnhook(); pendingDir = text || null;
        if (text) c.eventSource.on(dirEvent(), dirHook);
        if (diag) diag.path = '요청: 프롬프트 맨 끝에 유저 메시지로 직접 추가 (채팅 완성)';
    } else if (typeof c.setExtensionPrompt === 'function') {
        c.setExtensionPrompt(DIR_KEY, text, 1, 0, false, 0); // 위치 1=채팅 안, 깊이 0=맨 끝, 역할 0=system
        if (diag) diag.path = '요청: 내부 함수 setExtensionPrompt (채팅 안, 깊이 0, system)';
    } else if (typeof c.executeSlashCommandsWithOptions === 'function') { if (diag) diag.path = '요청: 슬래시 /inject'; // 내부 함수가 없는 버전은 슬래시 명령으로 (| 와 따옴표는 이스케이프)
        const q = t => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\|/g, '\\|');
        await c.executeSlashCommandsWithOptions(text ? `/inject id=${DIR_KEY} position=chat depth=0 role=system ephemeral=true "${q(text)}"` : `/flushinject ${DIR_KEY}`);
    } else throw new Error('주입 기능(setExtensionPrompt)을 찾을 수 없어요. SillyTavern을 업데이트해 주세요.');
    dirOn = !!text;
}
function clearDirection() { if (!dirOn) return; dirOn = false; setDirection('').catch(() => {}); }
// 방향 지시 유지: 보낸 // 줄을 따로 기억해 두었다가, 오류 뒤 재시도·재생성·스와이프·빈 입력 전송(비행기) 때 다시 붙인다. 새 메시지를 보내거나 채팅을 바꾸거나 캐릭터를 쓰면 지움
let keptReq = null; // 기억해 둔 // 줄 내용 (캐릭터는 기억하지 않음)
let keptFor = -1; // 그 // 줄을 보낸 유저 메시지의 위치
const lastUserIdx = () => { const ch = ctx().chat || []; for (let i = ch.length - 1; i >= 0; i--) if (ch[i]?.is_user) return i; return -1; };
async function reapplyDirection(type, dryRun) {
    try {
        if (dryRun || keptReq === null || pendingDir || run?.char || S().sendDir !== 'on') return; // 방금 보내서 아직 붙일 차례가 남아 있거나 캐릭터 생성 중이면 건너뜀 (이미 붙어 있어도 같은 문구를 다시 붙이는 건 무해해서, 오류 뒤 해제 신호가 안 와도 다시 붙게 함)
        if (!['normal', 'regenerate', 'swipe'].includes(type)) return; // 이어쓰기·백그라운드 생성 등은 제외
        const c = ctx(), ch = c.chat || [];
        if (type === 'normal' && !ch[ch.length - 1]?.is_user) return; // 비행기 재시도는 응답이 아직 없을 때(마지막이 내 메시지)만
        if (lastUserIdx() !== keptFor) return; // 그 // 줄을 보낸 메시지가 아직 마지막 유저 메시지일 때만
        await setDirection(c.substituteParams ? c.substituteParams(directionText(keptReq)) : directionText(keptReq));
    } catch (e) { logDirectionFail('재시도·재생성·스와이프 때 다시 붙이기', e); }
}
async function applySendDirection(id) { // 방향 지시: 보낸 메시지에서 // 줄을 떼어 캐릭터 반응 지시로 주입 (주입했으면 true)
    try {
        if (S().sendDir !== 'on') return false;
        const c = ctx(), msg = c.chat?.[id];
        if (!msg?.is_user || typeof msg.mes !== 'string') return false;
        const { draft, request } = splitRequest(msg.mes);
        if (!request || !draft.trim()) return false; // 첫 줄은 일반 글이어야 함 (// 로 시작하면 ST가 명령어로 처리)
        lastOriginal = msg.mes; origKind = 'dir'; respSeen = 0; firstRespIdx = id + 1; updateRestoreUI(); // 방향 지시: // 줄까지 포함한 원문을 복원용으로 보관 (오류·취소로 응답이 안 와도 되살릴 수 있게)
        msg.mes = draft.replace(/\s+$/, '');
        try { c.updateMessageBlock?.(id, msg); } catch { /* 무시 */ }
        await setDirection(c.substituteParams ? c.substituteParams(directionText(request)) : directionText(request));
        keptReq = request; keptFor = id; // 재시도·재생성·스와이프용으로 기억
        return true;
    } catch (e) { logDirectionFail('보낸 메시지의 // 줄 주입', e); return false; }
}
async function startGeneration() {
    const c = ctx();
    if (typeof c.executeSlashCommandsWithOptions === 'function') {
        const r = await c.executeSlashCommandsWithOptions('/trigger');
        if (diag) diag.trigger = `/trigger 반환: ${r?.isError ? '오류' : r?.isAborted ? '중단' : '정상'}`;
        if (r?.isError || r?.isAborted) throw new Error(r.abortReason || '/trigger 실행에 실패했어요.');
    } else if (typeof c.generate === 'function') { if (diag) diag.trigger = 'generate 호출'; await c.generate('normal'); }
    else throw new Error('응답 생성을 시작할 방법을 찾을 수 없어요. SillyTavern을 업데이트해 주세요.');
}
function stopChatGeneration() {
    const c = ctx();
    try { if (typeof c.stopGeneration === 'function') { c.stopGeneration(); return; } } catch { /* 아래 방법으로 */ }
    document.getElementById('mes_stop')?.click();
}
function restoreIfEmpty() { // 입력칸이 비어 있을 때만 초안을 되돌림 (그 사이 쓴 글을 덮어쓰지 않음)
    if (lastOriginal !== null && !document.getElementById('send_textarea').value) restoreOriginal();
}
function endCharacter(how) { // 응답 생성이 끝나거나 중지되면 쪽지를 빼고 일반 상태로 (원문은 복원용으로 남김)
    clearDirection();
    if (run?.char) { const m = run.mode; run = null; setBusy(m, false); }
    diagFinish(how);
}

/* 캐릭터 진단: 실행 중에만 ST 이벤트를 걸고 끝나면 푼다 (평소에는 돌지 않음). 키·토큰은 기록하지 않는다 */
const DIR_MARK = '[Response direction]';
let diag = null;
const diagEvents = () => { const t = ctx().event_types || {}; return [[t.GENERATION_STARTED, diagStarted], [t.CHAT_COMPLETION_PROMPT_READY, diagPrompt], [t.GENERATE_AFTER_COMBINING_PROMPTS, diagPrompt]].filter(([e]) => e); };
const describeMsg = m => `${m.is_user ? '유저' : m.is_system ? '시스템' : 'AI'} ${String(m.mes || '').length}자`; // 이름은 기록에 남기지 않음
const diagFields = (d = diag) => d ? {
    inject: d.path || '확인 불가',
    trigger: d.trigger || '확인 불가',
    prompt: d.prompt || '확인 불가 (프롬프트 이벤트 없음)',
} : {};
function diagApi() {
    const c = ctx();
    let model = '';
    try { model = c.getChatCompletionModel?.() || ''; } catch { /* 무시 */ }
    return [c.mainApi, c.chatCompletionSettings?.chat_completion_source, model].filter(Boolean).join(' / ');
}
function logDirectionFail(where, e) { // 방향 지시(// 줄) 주입이 조용히 실패하면 원인을 알 수 없어서 기록 (기록 자체가 실패해도 본 기능에는 영향 없음)
    try { addLog({ level: 'warn', result: '⚠️ 방향 지시 주입 실패', reason: '방향 지시 주입 실패', stage: where, detail: String(e?.message || e).slice(0, 300), api: diagApi(), env: `확장 v${VERSION}` }); } catch { /* 무시 */ }
}
function putDiag(entry) { // 이상(경고)만 기록한다. 정상 종료는 기록하지 않음
    addLog({ api: diagApi(), env: `확장 v${VERSION}`, ...entry });
}
function diagUnhook() {
    try { const es = ctx().eventSource; for (const [e, fn] of diagEvents()) (es.removeListener || es.off).call(es, e, fn); } catch { /* 무시 */ }
}
function diagDrop() { if (!diag) return; clearTimeout(diag.watch); diagUnhook(); diag = null; }
function diagBegin(mode, draft) {
    diagDrop();
    const c = ctx(), chat = c.chat || [], last = chat[chat.length - 1];
    const d = diag = { mode, t0: Date.now(), before: chat.length, last: last ? describeMsg(last) : '없음', draftChars: draft.length };
    try { for (const [e, fn] of diagEvents()) c.eventSource.on(e, fn); } catch { /* 진단이 실패해도 본 기능에는 영향 없음 */ }
    d.watch = setTimeout(() => { // 20초 동안 생성 시작 신호가 없으면 표시만 해 두고, 기록은 끝날 때 한 건으로 합친다
        if (diag !== d || d.started || d.prompt) return;
        d.noSignal = true;
    }, 20000);
}
function diagStarted() { // 생성이 시작된 순간의 채팅 변화 (유저 메시지가 이때 이미 생겼는지 구분)
    if (!diag || diag.started) return;
    diag.started = true;
    diag.atStart = (ctx().chat || []).slice(diag.before).map(describeMsg).join(', ') || '변화 없음';
}
function diagPrompt(data) { // 모델로 가는 프롬프트에 방향 지시가 실제로 들어갔는지 (서버 후처리 전 기준)
    if (!diag || diag.prompt || data?.dryRun || pendingDir) return; // 방향 지시를 아직 못 붙였으면 건너뜀
    const mark = diag.mark || DIR_MARK;
    const msgs = Array.isArray(data?.chat) ? data.chat : null;
    if (msgs) {
        const txt = m => typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map(x => x?.text || '').join('') : '';
        let at = -1;
        for (let i = msgs.length - 1; i >= 0; i--) if (txt(msgs[i]).includes(mark)) { at = i; break; }
        diag.found = at >= 0; diag.pos = msgs.length - 1 - at;
        const tail = msgs.slice(-4).map(m => `${m.role} ${txt(m).length}자`).join(' / ');
        diag.prompt = at < 0 ? '프롬프트에 방향 지시가 없음' : `맨 끝에서 ${diag.pos}번째, 역할 ${msgs[at].role}, 그 메시지 ${txt(msgs[at]).length}자 (방향 지시 ${diag.dirChars}자), 전체 ${msgs.length}개 / 끝 4개: ${tail}`;
    } else if (typeof data?.prompt === 'string') {
        const k = data.prompt.lastIndexOf(mark);
        diag.found = k >= 0;
        diag.prompt = k < 0 ? '프롬프트에 방향 지시가 없음' : `텍스트 완성, 맨 끝에서 ${data.prompt.length - k}자 앞`;
    }
}
function diagFinish(how) { // how: 정상 / 중지 / 취소 / 채팅 변경
    const d = diag;
    if (!d) return;
    clearTimeout(d.watch); diagUnhook(); diag = null;
    if (how === '채팅 변경') return;
    setTimeout(() => { // 응답이 채팅에 들어갈 시간을 조금 주고 한 번만 확인
        const chat = ctx().chat || [];
        const added = d.before >= 0 ? chat.slice(d.before) : [];
        const warns = [];
        if (d.noSignal) warns.push('시작 후 20초 동안 생성 신호가 없었어요');
        if (how === '정상') {
            if (added.some(m => m.is_user)) warns.push('유저 메시지가 생겼어요 (초안이 내 메시지로 올라갔을 수 있어요)');
            if (added.length > 1) warns.push(`새 메시지가 ${added.length}개예요`);
            if (!d.prompt) warns.push('방향 지시가 프롬프트에 추가됐는지 확인하지 못했어요 (프롬프트 이벤트 없음)');
            else if (!d.found) warns.push('생성 프롬프트에서 방향 지시를 찾지 못했어요');
            else if (d.pos > 2) warns.push(`방향 지시가 프롬프트 맨 끝에서 ${d.pos}번째라 약할 수 있어요`);
        }
        if (!warns.length) return; // 이상이 없으면 기록하지 않음
        putDiag({
            level: 'warn',
            result: `⚠️ 캐릭터 이상 감지 (${how})`,
            reason: `이상 감지 (${how})`,
            detail: warns.join(' / '),
            mode: MODE[d.mode].label, inputChars: d.draftChars,
            ...diagFields(d),
            chat: `시작 전 ${d.before}개 (마지막: ${d.last})${d.atStart === '변화 없음' ? '' : ` / 생성 시작 시 새 메시지: ${d.atStart ?? '시작 신호 없음'}`} / 종료 후 새 메시지: ${added.map(describeMsg).join(', ') || '없음'}`,
            elapsed: `${((Date.now() - d.t0) / 1000).toFixed(1)}초`,
        });
    }, 600);
}
async function runCharacter(mode) {
    const ta = document.getElementById('send_textarea');
    const draft = ta.value;
    const empty = !draft.trim(); // 빈 초안이면 방향 지시 대신 캐릭터 시점 안내문을 넣음
    const id = ++runCounter;
    keptReq = null; // 캐릭터는 방향 지시 유지 대상이 아님 (이전 // 줄이 캐릭터 응답의 스와이프에 붙지 않게)
    run = { id, mode, char: true, cancelled: false };
    setBusy(mode, true);
    if (empty) clearOriginal(); else { lastOriginal = draft; origKind = 'char'; respSeen = 0; firstRespIdx = (ctx().chat || []).length; } // 빈 초안은 복원할 원문이 없음
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    updateRestoreUI();
    diagBegin(mode, draft);
    let stage = '방향 지시 주입';
    try {
        const c = ctx();
        const sub = t => c.substituteParams ? c.substituteParams(t) : t;
        const dirText = sub(empty ? CHARACTER_INITIATIVE : directionText(draft));
        if (diag) { diag.dirChars = dirText.length; diag.mark = empty ? sub(CHARACTER_INITIATIVE_HEADER) : DIR_MARK; } // 진단이 찾을 머리말 (캐릭터 이름이 들어간 상태)
        await setDirection(dirText);
        if (run?.id !== id) { clearDirection(); return; } // 그 사이 취소됨
        stage = '응답 생성 시작';
        await startGeneration();
    } catch (e) {
        if (!run || run.id !== id) return; // 취소·중지는 실패 아님
        run = null; setBusy(mode, false);
        clearDirection(); restoreIfEmpty();
        const f = diagFields(); diagDrop();
        failToast('👻 캐릭터 응답 시작 실패 👻');
        addLog({ level: 'fail', result: '❌ 실패', stage, reason: e?.name || 'Error', detail: String(e?.message || e).slice(0, 600), mode: MODE[mode].label, inputChars: draft.length, ...f, api: diagApi(), env: `확장 v${VERSION}` });
    }
}

const unifiedKey = st => (PERSPECTIVE[st.unifiedPick] || st.unifiedPick === 'character') ? st.unifiedPick : 'first'; // 올인원이 고른 시점 (캐릭터 포함)
function onIconClick(mode) {
    if (run) { if (run.mode === mode) cancelRun(); return; } // 같은 아이콘을 다시 누르면 취소 (알림 없음)
    const pick = mode === 'unified' ? unifiedKey(S()) : mode;
    if (pick === 'character') runCharacter(mode); else runGhostpen(mode);
}
function setBusy(mode, busy) {
    $('#ghostpen_bar').toggleClass('gpen-busy', busy).toggleClass('gpen-busychar', busy && !!run?.char);
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
    clearOriginal();
}
function clearOriginal() { lastOriginal = null; origKind = ''; respSeen = 0; firstRespIdx = -1; updateRestoreUI(); }


/* 아이콘 꾸미기 */
const ICON_KEYS = ['first', 'third', 'keep', 'character', 'unified', 'restore'];
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
    if (!spin && c.kind === 'image' && safeSrc(c.img)) return `<img src="${esc(c.img)}" alt="" draggable="false">`; // draggable="false": 꾹 누를 때 이미지가 끌려 나가 터치가 끊기는 것 방지
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
let iconPane = ''; // 설정에서 열린 칸: '' (모두 닫힘) | 'place' | 'deco'
function decoHtml() {
    const c = ic(decoSel);
    const seg = (attr, v, label, cur) => `<button type="button" class="gpen-btn gpen-seg ${cur === v ? 'gpen-on' : ''}" data-${attr}="${v}"><span>${label}</span></button>`;
    // 선택 줄: 위 3개(1인칭·3인칭·고정X) + 아래 3개(캐릭터·올인원·복원), 배치는 CSS .gpen-dselgrid
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
      <div class="gpen-row gpen-dselgrid">${sels}</div>
      <div class="gpen-deco-preview"><div class="gpen-icon" style="${iconStyle(decoSel)}cursor:default">${iconInner(decoSel)}</div></div>
      <div class="gpen-field"><label>모양</label><div class="gpen-row">${seg('dkind', 'default', '기본', c.kind)}${seg('dkind', 'emoji', '이모지', c.kind)}${seg('dkind', 'image', '이미지', c.kind)}</div>${kindBody}</div>
      <div class="gpen-field"><label>크기 (px)</label><div class="gpen-dstep"><button type="button" class="gpen-btn gpen-dstep-btn" data-dd="-1"><i class="fa-solid fa-minus"></i></button><span class="gpen-step-val">${Math.min(64, Math.max(20, Number(c.size) || 32))}</span><button type="button" class="gpen-btn gpen-dstep-btn" data-dd="1"><i class="fa-solid fa-plus"></i></button></div></div>
      ${c.kind === 'default' ? colorRow('color', '아이콘 색', c.color) : ''}
      <div class="gpen-field"><label>테두리 모양</label><div class="gpen-row">${Object.entries(SHAPES).map(([v, l]) => seg('dshape', v, l, c.shape)).join('')}</div></div>
      ${c.shape !== 'none' ? colorRow('bcolor', '테두리 색', c.bcolor) : ''}
      <div class="gpen-row"><button type="button" class="gpen-btn gpen-wide" data-dreset><i class="fa-solid fa-rotate-left"></i><span>이 아이콘 기본값</span></button><button type="button" class="gpen-btn gpen-wide" data-dresetall><i class="fa-solid fa-trash-arrow-up"></i><span>전부 기본값 복원</span></button></div>`;
}

/* 올인원 아이콘: 짧게 누르면 대필, 0.5초 이상 꾹 누르면 시점 선택 메뉴 */
const LONG_PRESS_MS = 500;
function closePickMenu() { $('#gpen_pickmenu').remove(); $(document).off('.gpenpick'); }
function openPickMenu(anchor) {
    closePickMenu();
    const cur = unifiedKey(S());
    const menu = $(`<div id="gpen_pickmenu" role="menu">${['first', 'third', 'keep', 'character'].map(k =>
        `<div class="gpen-pickitem ${k === cur ? 'gpen-on' : ''}" data-pick="${k}"><i class="fa-solid ${MODE[k].icon}"></i><span>${MODE[k].label}</span></div>`).join('')}</div>`);
    $('body').append(menu);
    const r = anchor[0].getBoundingClientRect(); // 아이콘 위쪽에 띄우고, 공간이 없으면 아래쪽, 화면 밖으로는 안 나가게
    const w = menu.outerWidth(), h = menu.outerHeight();
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    const top = r.top - h - 8 >= 8 ? r.top - h - 8 : r.bottom + 8;
    menu.css({ left, top });
    menu.on('click', '.gpen-pickitem', function () { // 고르면 저장하고 아이콘 툴팁도 새로 그림
        S().unifiedPick = $(this).data('pick'); save();
        closePickMenu(); buildBar();
    });
    setTimeout(() => { // 메뉴 바깥을 누르거나 Esc를 누르면 닫기 (꾹 누른 손을 뗄 때는 닫히지 않게 한 박자 늦게 등록)
        $(document).on('pointerdown.gpenpick', e => { if (!$(e.target).closest('#gpen_pickmenu').length) closePickMenu(); });
        $(document).on('keydown.gpenpick', e => { if (e.key === 'Escape') closePickMenu(); });
    }, 0);
}
function bindUnifiedPress(el) {
    let timer = null, fired = false;
    const stop = () => { clearTimeout(timer); timer = null; };
    el.on('pointerdown', () => {
        fired = false; stop();
        if (run) return; // 대필 중에는 꾹 누르기 없음 (다시 누르면 취소)
        timer = setTimeout(() => { timer = null; fired = true; openPickMenu(el); }, LONG_PRESS_MS);
    });
    el.on('pointerup pointerleave pointercancel', stop);
    el.on('contextmenu', e => e.preventDefault()); // 폰에서 꾹 누를 때 뜨는 기본 메뉴 막기
    el.on('click', () => { if (fired) { fired = false; return; } onIconClick('unified'); }); // 꾹 누른 뒤 손을 뗄 때 생기는 클릭은 무시
}

/* UI */
function buildBar() {
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
        const title = k === 'unified' ? `${v.label} (${MODE[unifiedKey(st)].label}) - 꾹 누르면 시점 선택` : v.label;
        const el = $(`<div class="gpen-icon" data-mode="${k}" title="${title}" style="${iconStyle(k)}">${iconInner(k)}</div>`);
        if (k === 'unified') bindUnifiedPress(el); else el.on('click', () => onIconClick(k));
        el.appendTo(icons);
    }
    bar.prepend(icons.children());
    bar.removeClass('gpen-al-left gpen-al-center gpen-al-right').addClass(`gpen-al-${alignOf(st)}`);
    $('#send_form').removeClass('gpen-custom gpen-ded1 gpen-ded2'); // 레이아웃을 늘릴 때 새 클래스도 여기서 먼저 지울 것
    const rightForm = $('#rightSendForm');
    const nonQR = $('#nonQRFormItems');
    if (st.place === 'custom' && rightForm.length) { // 커스텀: 오른쪽 버튼 영역 안, 전송 버튼 바로 앞 (입력창 구조는 건드리지 않음)
        const sendBut = $('#send_but');
        if (sendBut.length && sendBut.parent().is(rightForm)) sendBut.before(bar); else rightForm.prepend(bar);
        $('#send_form').addClass('gpen-custom');
    } else if ((st.place === 'ded1' || st.place === 'ded2') && rightForm.length) { // 전용1·2: 입력창 묶음 안, 오른쪽 묶음 바로 앞 (배치는 CSS가 담당)
        rightForm.before(bar);
        $('#send_form').addClass(`gpen-${st.place}`);
    } else if (nonQR.length) nonQR.before(bar); else $('#send_form').prepend(bar); // 기본: 입력창 위 별도 줄
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

          <div class="gpen-section-title">시점</div>
          <div class="gpen-row gpen-chipgrid">${chip('first')}${chip('third')}${chip('keep')}${chip('character')}${chip('unified')}</div>
          <div class="gpen-section-title">강도</div>
          <div class="gpen-row">${segBtn('intensity', 'weak', '약')}${segBtn('intensity', 'mid', '중')}${segBtn('intensity', 'strong', '강')}</div>

          <div class="gpen-section-title">분량</div>
          <div class="gpen-row">${lenBtn('short', '짧게')}${lenBtn('normal', '보통')}${lenBtn('long', '길게')}</div>
          <details class="gpen-fold gpen-fold-sub" data-fold="len" ${lenOpen ? 'open' : ''}>
            <summary>글자 수</summary>
            <div class="gpen-field gpen-inline"><label>최소</label>${step('minChars', 50, 6000, 50, st.minChars)}</div>
            <div class="gpen-field gpen-inline"><label>최대</label>${step('maxChars', 50, 6000, 50, st.maxChars)}</div>
          </details>

          <div class="gpen-section-title">화면 설정</div>
          <div class="gpen-row">${[['place', '레이아웃'], ['deco', '아이콘 꾸미기']].map(([k, l]) => `<button type="button" class="gpen-btn gpen-seg ${iconPane === k ? 'gpen-on' : ''}" data-ipane="${k}"><span>${l}</span></button>`).join('')}</div>
          <div class="gpen-ipane" data-ipane-body="place" ${iconPane === 'place' ? '' : 'hidden'}><div class="gpen-row gpen-chipgrid">${[['row', '기본'], ['custom', '커스텀'], ['ded1', '전용1'], ['ded2', '전용2']].map(([v, l]) => `<button type="button" class="gpen-btn gpen-seg ${st.place === v ? 'gpen-on' : ''}" data-dplace="${v}"><span>${l}</span></button>`).join('')}</div><div class="gpen-row">${[['left', '왼쪽'], ['center', '가운데'], ['right', '오른쪽']].map(([v, l]) => `<button type="button" class="gpen-btn gpen-seg ${alignOf(st) === v ? 'gpen-on' : ''}" data-dalign="${v}"><span>${l}</span></button>`).join('')}</div></div>
          <div class="gpen-ipane" data-ipane-body="deco" ${iconPane === 'deco' ? '' : 'hidden'}><div class="gpen-deco-body">${decoHtml()}</div></div>

          <div class="gpen-section-title">추가 설정</div>
          <details class="gpen-fold" data-fold="dir" ${dirOpen ? 'open' : ''}>
            <summary>방향 지시</summary>
            <div class="gpen-row">${segBtn('sendDir', 'on', '켜기')}${segBtn('sendDir', 'off', '끄기')}</div>
          </details>

          <details class="gpen-fold" data-fold="gen" ${genOpen ? 'open' : ''}>
            <summary>생성 옵션</summary>
            <div class="gpen-field"><label>연결 프로필</label>
              <select class="text_pole" data-k="profileId">${opt('', '선택 안 함', st.profileId)}${profiles.map(p => opt(p.id, p.name, st.profileId)).join('')}</select></div>
            <div class="gpen-field"><label>참고할 최근 채팅 수</label>${step('recent', 0, 50, 1, st.recent)}</div>
            <div class="gpen-field"><label>시간 제한 (초)</label>${step('timeoutSec', 10, 600, 10, st.timeoutSec)}</div>
            <div class="gpen-field"><label>최대 출력 토큰</label>${step('maxTokens', 1000, 32000, 500, st.maxTokens)}</div>
          </details>
        </div>

        <div class="gpen-pane ${curTab === 'log' ? 'on' : ''}" data-pane="log">
          <div class="gpen-logbar">
            <span class="gpen-muted">기록은 원문과 결과 내용 없이 개수와 오류만 저장돼요. (단, 달라진 따옴표 내용은 앞부분만 짧게 같이 저장돼요.) 최근 ${MAX_LOGS}건까지 보관해요.</span>
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
    root.on('click.gpen', '.gpen-fold > summary', function () { // 접이식 칸마다 펼침 상태를 따로 기억 (화면을 다시 그려도 유지)
        const open = !$(this).parent().prop('open'), f = $(this).parent().attr('data-fold');
        if (f === 'dir') dirOpen = open; else if (f === 'gen') genOpen = open; else lenOpen = open;
    });
    root.on('change.gpen', 'select[data-k]', function () { S()[$(this).data('k')] = this.value; save(); });
    const refreshDeco = () => root.find('.gpen-deco-body').html(decoHtml());
    const refreshPreview = () => root.find('.gpen-deco-preview .gpen-icon').attr('style', iconStyle(decoSel) + 'cursor:default').html(iconInner(decoSel));
    const warn = msg => { try { window.toastr?.warning(msg); } catch { /* 무시 */ } };
    root.on('click.gpen', '[data-ipane]', function () { // 누른 칸만 열고, 열린 칸을 다시 누르면 닫음
        const k = $(this).attr('data-ipane');
        iconPane = iconPane === k ? '' : k;
        root.find('[data-ipane]').each(function () { $(this).toggleClass('gpen-on', $(this).attr('data-ipane') === iconPane); });
        root.find('[data-ipane-body]').each(function () { $(this).prop('hidden', $(this).attr('data-ipane-body') !== iconPane); });
    });
    root.on('click.gpen', '.gpen-colorfold > summary', function () { const d = $(this).parent(); decoColorOpen[d.data('k')] = !d.prop('open'); });
    root.on('click.gpen', '[data-dplace]', function () {
        S().place = $(this).data('dplace'); save(); buildBar();
        root.find('[data-dplace]').each(function () { $(this).toggleClass('gpen-on', $(this).data('dplace') === S().place); });
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
        const btn = $(this);
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
    const item = $('<div id="ghostpen_wand" class="list-group-item flex-container flexGap5"><div class="extensionsMenuExtensionButton fa-solid fa-pen-nib"></div><span>고스트펜</span></div>');
    item.on('click', () => { $('#extensionsMenu').hide(); openPopup(); });
    $('#extensionsMenu').append(item);
}

function addDrawer() {
    if ($('#ghostpen_drawer').length) return;
    const html = $(`<div id="ghostpen_drawer" class="extension_container"><div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header"><b><i class="fa-solid fa-pen-nib"></i> 고스트펜</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
      <div class="inline-drawer-content"><div class="gpen-drawer-body"></div></div></div></div>`);
    $('#extensions_settings2').append(html);
    const body = html.find('.gpen-drawer-body');
    renderPanel(body);
    html.find('.inline-drawer-toggle').on('click', () => renderPanel(body)); // 열 때 프로필 목록 갱신
}

jQuery(() => {
    { const st = S(); if (st.logs.some(l => l.level === 'info')) { st.logs = st.logs.filter(l => l.level !== 'info'); save(); } } // 이전 버전의 정상 기록 정리
    buildBar();
    addWandItem();
    addDrawer();
    try { // ST 이벤트 연결: 전송·채팅 변경·생성 시작/끝/중지에 맞춰 원문 보관과 방향 지시 주입을 정리
        const { eventSource, event_types } = ctx();
        const missing = [];
        const on = (name, fn, core = true) => { const e = event_types?.[name]; if (e) eventSource.on(e, fn); else if (core) missing.push(name); };
        on('MESSAGE_SENT', async id => { cancelGhost(); if (origKind === 'ghost') clearOriginal(); if (!(await applySendDirection(id))) { clearDirection(); keptReq = null; } }); // 대필 원문만 비움 (캐릭터·방향 지시 원문은 응답이 와야 지움). 방향 지시가 있으면 원문 보관 + 주입
        on('CHAT_CHANGED', () => { cancelGhost(); endCharacter('채팅 변경'); clearOriginal(); keptReq = null; });
        on('GENERATION_ENDED', () => endCharacter('정상'));
        on('GENERATION_STOPPED', () => endCharacter('중지'));
        // 대필 원문: 새 응답 생성이 시작되면 복원 아이콘 삭제 (스와이프·재생성·이어쓰기·백그라운드 생성은 제외). 캐릭터·방향 지시 원문은 아래 MESSAGE_RECEIVED에서 지움
        on('GENERATION_STARTED', (type, params, dryRun) => { if (!dryRun && origKind === 'ghost' && !run?.char && !diag && !['swipe', 'regenerate', 'continue', 'quiet', 'impersonate'].includes(type)) clearOriginal(); }, false);
        // 방향 지시 유지: 생성이 시작될 때 기억해 둔 // 줄을 다시 붙임 (오류 뒤 재시도·재생성·스와이프·빈 입력 전송)
        on('GENERATION_STARTED', (type, params, dryRun) => reapplyDirection(type, dryRun), false);
        // 캐릭터·방향 지시 원문: 원문에 대한 첫 응답은 남겨 두고, 그다음 새 응답(두 번째)이 오면 지움. 오류·취소로 응답이 안 오면 몇 번을 재시도해도 남음
        on('MESSAGE_RECEIVED', (mid, type) => { // 응답 위치로 판단: 첫 응답 위치(스와이프·재생성·같은 응답의 중복 신호 포함)는 남기고, 그보다 뒤 위치에 AI 응답이 새로 생기면 지움
            if (lastOriginal === null || origKind === 'ghost' || ['quiet', 'impersonate'].includes(type)) return;
            const idx = Number(mid), m = ctx().chat?.[idx];
            if (m?.is_user || m?.is_system) return; // 유저·시스템 메시지는 응답이 아님
            if (Number.isNaN(idx) || firstRespIdx < 0) { if (++respSeen >= 2) clearOriginal(); return; } // 위치를 모르면 예전 방식(응답 수)
            if (idx > firstRespIdx) clearOriginal();
        });
        if (missing.length) { // 핵심 이벤트가 없으면 기능이 조용히 안 되므로 기록 (같은 내용은 한 건만 유지)
            S().logs = S().logs.filter(l => l.reason !== '이벤트 등록 실패');
            addLog({ level: 'warn', result: '⚠️ 이벤트 등록 실패', reason: '이벤트 등록 실패', detail: `SillyTavern에서 찾지 못한 이벤트: ${missing.join(', ')}`, env: `확장 v${VERSION}` });
        }
    } catch { /* 무시 */ }
    document.getElementById('send_but')?.addEventListener('click', () => cancelGhost(), true); // 전송 버튼 (대필 중이 아니면 아무 일도 안 함)
    let tries = 0;
    const iv = setInterval(() => { addWandItem(); if ($('#ghostpen_wand').length || ++tries > 20) clearInterval(iv); }, 1000);
});
