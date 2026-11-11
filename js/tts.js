// tts.js — 발음·본문 듣기 (Web Speech API)
//   영어 용어·영어 문장: en-US      한국어 본문: ko-KR
// 지원하지 않는 브라우저에서는 isSupported() 가 false 이고 버튼을 숨긴다.

import { getSettings } from './db.js';
import { clamp } from './util.js';

let token = 0;            // 재생을 구분하는 번호(중간에 멈추면 이어지는 문장을 버린다)
let voicesPromise = null;

export function isSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
}

/** 기기에 설치된 음성 목록. 크롬은 처음에 비어 있다가 나중에 채워지므로 잠깐 기다린다. */
export function loadVoices() {
  if (!isSupported()) return Promise.resolve([]);
  if (voicesPromise) return voicesPromise;
  voicesPromise = new Promise((resolve) => {
    const synth = window.speechSynthesis;
    const now = synth.getVoices();
    if (now.length) { resolve(now); return; }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve(synth.getVoices());
    };
    synth.addEventListener('voiceschanged', finish, { once: true });
    setTimeout(finish, 1500);
  }).then((list) => {
    if (!list.length) voicesPromise = null;   // 다음에 다시 시도
    return list;
  });
  return voicesPromise;
}

/** 언어(예: 'en', 'ko')에 맞는 음성 목록. */
export async function voicesFor(langPrefix) {
  const all = await loadVoices();
  const p = langPrefix.toLowerCase();
  return all.filter((v) => v.lang && v.lang.toLowerCase().replace('_', '-').startsWith(p));
}

async function pickVoice(lang, preferredUri) {
  const list = await voicesFor(lang.slice(0, 2));
  if (!list.length) return null;
  if (preferredUri) {
    const chosen = list.find((v) => v.voiceURI === preferredUri);
    if (chosen) return chosen;
  }
  const exact = list.filter((v) => v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase());
  const pool = exact.length ? exact : list;
  return pool.find((v) => v.default) ?? pool.find((v) => v.localService) ?? pool[0];
}

export function stop() {
  token += 1;
  if (isSupported()) window.speechSynthesis.cancel();
}

export function isSpeaking() {
  return isSupported() && (window.speechSynthesis.speaking || window.speechSynthesis.pending);
}

/**
 * 문장들을 차례로 읽는다. 긴 글을 한 번에 넣으면 일부 브라우저가 중간에 끊으므로 문장 단위로 나눠 넣는다.
 * @param {string[]} sentences
 * @param {{ lang?: string, onEnd?: Function, onSentence?: (i:number)=>void }} [opts]
 * @returns {Promise<boolean>} 재생을 시작했으면 true
 */
export async function speakAll(sentences, { lang = 'ko-KR', onEnd, onSentence } = {}) {
  if (!isSupported()) return false;
  const list = (sentences ?? []).map((s) => String(s ?? '').trim()).filter(Boolean);
  if (!list.length) return false;
  stop();
  const mine = token;
  const settings = await getSettings();
  const voice = await pickVoice(lang, lang.startsWith('en') ? settings.ttsVoiceEn : settings.ttsVoiceKo);
  if (mine !== token) return false;
  const rate = clamp(Number(settings.ttsRate) || 1, 0.5, 2);
  const synth = window.speechSynthesis;

  list.forEach((text, i) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = voice?.lang ?? lang;
    if (voice) u.voice = voice;
    u.rate = rate;
    u.onstart = () => { if (mine === token && onSentence) onSentence(i); };
    const finish = () => { if (mine === token && i === list.length - 1 && onEnd) onEnd(); };
    u.onend = finish;
    u.onerror = finish;
    synth.speak(u);
  });
  return true;
}

/** 짧은 글 하나를 읽는다(영어 용어·영어 문장). */
export function speak(text, opts = {}) {
  return speakAll([text], { lang: 'en-US', ...opts });
}
