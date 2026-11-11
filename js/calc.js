// calc.js — 계산기 4종 (#/calc, #/calc/:kind) + SVG 막대 그래프
//   compound  복리·적립식      valuation  PER·PBR·ROE
//   dividend  배당수익률        avgcost    평단가
//
// 계산은 순수 함수(compound, valuation, roeFromTotals, dividend, avgCost)로 떼어 tests/calc.test.mjs 에서 검증한다.
// 입력값은 기기 밖으로 나가지 않고 저장하지도 않는다(화면을 떠나면 사라진다).

import { html, raw, setHtml, fmtNum, formatValue, parseInputNumber, escapeHtml } from './util.js';
import * as db from './db.js';
import { loadCurriculum, loadIndex } from './lessons.js';

/* ───────────────────────── 순수 계산 함수 ───────────────────────── */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * 복리·적립식. 가정: 연 수익률 ÷ 12 를 매달 복리로 적용하고, 적립금은 매달 초에 넣는다. 세금·수수료는 없다고 본다.
 * @param {{ initial?: number, monthly?: number, annualRatePct?: number, years?: number }} input
 * @returns {{ finalValue:number, principal:number, profit:number, months:number, yearly: Array<{ year:number, principal:number, value:number, profit:number }> }}
 */
export function compound({ initial = 0, monthly = 0, annualRatePct = 0, years = 0 } = {}) {
  const months = Math.max(0, Math.round(years * 12));
  const r = annualRatePct / 100 / 12;
  let value = initial;
  let principal = initial;
  const yearly = [];
  for (let m = 1; m <= months; m += 1) {
    value += monthly;             // 월초 적립
    principal += monthly;
    value *= 1 + r;               // 그 달의 수익
    if (m % 12 === 0 || m === months) yearly.push({ year: m / 12, principal, value, profit: value - principal });
  }
  return { finalValue: value, principal, profit: value - principal, months, yearly };
}

/**
 * 밸류에이션. 아는 값(주가·EPS·BPS·PER·PBR·ROE)에서 알 수 있는 나머지를 구한다. ROE 는 % 단위.
 *   PER = 주가 ÷ EPS,  PBR = 주가 ÷ BPS,  ROE = EPS ÷ BPS = PBR ÷ PER
 * 입력으로 준 값은 바꾸지 않는다. 구할 수 없는 값은 null.
 */
export function valuation(input = {}) {
  const v = {
    price: num(input.price), eps: num(input.eps), bps: num(input.bps),
    per: num(input.per), pbr: num(input.pbr), roe: num(input.roe),
  };
  const notes = [];
  const pos = (x) => x !== null && x > 0;
  for (let i = 0; i < 6; i += 1) {
    let changed = false;
    const set = (key, value) => {
      if (v[key] === null && Number.isFinite(value)) { v[key] = value; changed = true; }
    };
    if (v.price !== null && pos(v.eps)) set('per', v.price / v.eps);
    if (v.price !== null && pos(v.bps)) set('pbr', v.price / v.bps);
    if (v.eps !== null && pos(v.bps)) set('roe', (v.eps / v.bps) * 100);
    if (pos(v.per) && v.pbr !== null) set('roe', (v.pbr / v.per) * 100);
    if (v.per !== null && v.roe !== null) set('pbr', (v.per * v.roe) / 100);
    if (v.pbr !== null && pos(v.roe)) set('per', v.pbr / (v.roe / 100));
    if (v.per !== null && v.eps !== null) set('price', v.per * v.eps);
    if (v.pbr !== null && v.bps !== null) set('price', v.pbr * v.bps);
    if (v.price !== null && pos(v.per)) set('eps', v.price / v.per);
    if (v.price !== null && pos(v.pbr)) set('bps', v.price / v.pbr);
    if (v.roe !== null && v.bps !== null) set('eps', (v.roe / 100) * v.bps);
    if (v.eps !== null && pos(v.roe)) set('bps', v.eps / (v.roe / 100));
    if (!changed) break;
  }
  if (v.eps !== null && v.eps <= 0 && num(input.per) === null) {
    v.per = null;
    notes.push('EPS가 0 이하(적자)이면 PER은 의미가 없어 계산하지 않아요.');
  }
  if (v.bps !== null && v.bps <= 0) notes.push('BPS가 0 이하(자본잠식)이면 PBR·ROE를 해석할 수 없어요.');
  return { ...v, notes };
}

/** 순이익과 자본으로 ROE(%)를 구한다. */
export function roeFromTotals(netIncome, equity) {
  if (num(netIncome) === null || num(equity) === null || equity <= 0) return null;
  return (netIncome / equity) * 100;
}

/**
 * 배당. 세율은 % (국내 기본 15.4% = 소득세 14% + 지방소득세 1.4%).
 * @returns {{ yieldPct:number, netDps:number, taxPerShare:number, netYieldPct:number, gross:number|null, tax:number|null, net:number|null } | null}
 */
export function dividend({ price, dps, taxRatePct = 15.4, shares = null } = {}) {
  if (num(price) === null || num(dps) === null || price <= 0 || dps < 0) return null;
  const rate = Math.min(100, Math.max(0, num(taxRatePct) ?? 0)) / 100;
  const taxPerShare = dps * rate;
  const netDps = dps - taxPerShare;
  const n = num(shares);
  return {
    yieldPct: (dps / price) * 100,
    netDps,
    taxPerShare,
    netYieldPct: (netDps / price) * 100,
    gross: n !== null && n >= 0 ? dps * n : null,
    tax: n !== null && n >= 0 ? taxPerShare * n : null,
    net: n !== null && n >= 0 ? netDps * n : null,
  };
}

/**
 * 평단가(평균 매입 단가). 추가 매수 뒤의 평균 단가와 변화율.
 * @returns {{ totalQty:number, totalCost:number, newAvg:number, changePct:number|null } | null}
 */
export function avgCost({ qty = 0, avgPrice = 0, addQty = 0, addPrice = 0 } = {}) {
  if ([qty, avgPrice, addQty, addPrice].some((x) => num(x) === null || x < 0)) return null;
  const totalQty = qty + addQty;
  if (totalQty <= 0) return null;
  const totalCost = qty * avgPrice + addQty * addPrice;
  const newAvg = totalCost / totalQty;
  return {
    totalQty,
    totalCost,
    newAvg,
    changePct: qty > 0 && avgPrice > 0 ? ((newAvg - avgPrice) / avgPrice) * 100 : null,
  };
}

/* ───────────────────────── SVG 막대 그래프 ───────────────────────── */

function niceMax(v) {
  if (!(v > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (v <= m * mag) return m * mag;
  return 10 * mag;
}

function axisLabel(v) {
  if (v === 0) return '0';
  if (v >= 1e12) return `${fmtNum(v / 1e12, 1)}조`;
  if (v >= 1e8) return `${fmtNum(v / 1e8, 1)}억`;
  if (v >= 1e4) return `${fmtNum(v / 1e4, 0)}만`;
  return fmtNum(v, 0);
}

/** 연도별 원금·수익 막대 그래프(SVG 문자열). 외부 라이브러리를 쓰지 않는다. */
export function compoundChartSvg(yearly) {
  const W = 640;
  const H = 300;
  const pad = { l: 52, r: 10, t: 12, b: 30 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const n = yearly.length;
  if (n === 0) return '';
  const max = niceMax(Math.max(...yearly.map((y) => Math.max(y.value, y.principal))));
  const y = (v) => pad.t + innerH - (Math.max(0, v) / max) * innerH;
  const slot = innerW / n;
  const bw = Math.max(2, Math.min(34, slot * 0.68));
  const step = n <= 12 ? 1 : n <= 24 ? 2 : n <= 40 ? 5 : 10;

  let out = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="연도별 원금과 평가 금액 막대 그래프">`;
  for (let i = 0; i <= 4; i += 1) {
    const v = (max / 4) * i;
    const yy = y(v);
    out += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}"/>`;
    out += `<text x="${pad.l - 6}" y="${(yy + 4).toFixed(1)}" text-anchor="end">${escapeHtml(axisLabel(v))}</text>`;
  }
  yearly.forEach((row, i) => {
    const x = pad.l + slot * i + (slot - bw) / 2;
    const base = y(0);
    const low = Math.min(row.principal, row.value);
    const yLow = y(low);
    out += `<rect class="bar-principal" x="${x.toFixed(1)}" y="${yLow.toFixed(1)}" width="${bw.toFixed(1)}" height="${(base - yLow).toFixed(1)}" rx="2"/>`;
    if (row.value > row.principal) {
      const yTop = y(row.value);
      out += `<rect class="bar-profit" x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${(yLow - yTop).toFixed(1)}" rx="2"/>`;
    }
    const yr = Math.round(row.year * 10) / 10;
    if (i === n - 1 || Number.isInteger(yr) && yr % step === 0) {
      out += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle">${escapeHtml(String(yr))}년</text>`;
    }
  });
  out += '</svg>';
  return out;
}

/* ───────────────────────── 화면 ───────────────────────── */

const KINDS = [['compound', '복리·적립식'], ['valuation', 'PER·PBR·ROE'], ['dividend', '배당'], ['avgcost', '평단가']];
const won = (v) => formatValue(v, '원');
const wonExact = (v) => `${fmtNum(v, 0)}원`;

// 화면을 오가도 입력이 남도록 메모리에만 잠시 둔다(저장하지 않음).
const memory = {
  compound: { initial: '0', monthly: '500,000', rate: '7', years: '20' },
  valuation: { price: '', eps: '', bps: '', per: '', pbr: '', roe: '', netIncome: '', equity: '' },
  dividend: { price: '', dps: '', shares: '', tax: null },
  avgcost: { qty: '', avgPrice: '', addQty: '', addPrice: '' },
};

function field(name, label, value, { hint = '', unit = '', placeholder = '' } = {}) {
  return html`<label class="field"><span>${label}${unit ? html` <small>(${unit})</small>` : ''}</span>
    <input type="text" inputmode="decimal" name="${name}" value="${value ?? ''}" placeholder="${placeholder}" autocomplete="off">
    ${hint ? html`<span class="field-hint">${hint}</span>` : ''}</label>`;
}

function item(label, value, cls = '') {
  return html`<div class="result-item ${cls}"><div class="label">${label}</div><div class="value">${value}</div></div>`;
}

async function learnedLinks(kind) {
  const [curriculum, index] = await Promise.all([loadCurriculum(), loadIndex()]);
  const lessons = curriculum.lessons.filter((l) => Array.isArray(l.calc) && l.calc.includes(kind));
  return lessons.map((l) => {
    const pub = index.items.find((it) => !it.sample && it.lesson_no === l.no) ?? index.items.find((it) => it.sample && it.lesson_no === l.no);
    return { no: l.no, title: l.title, date: pub?.date ?? null, sample: pub?.sample === true };
  });
}

export async function render(page, { kind } = {}) {
  const active = KINDS.some(([k]) => k === kind) ? kind : 'compound';
  const settings = await db.getSettings();
  if (memory.dividend.tax === null) memory.dividend.tax = String(settings.dividendTaxRate ?? 15.4);
  const links = await learnedLinks(active);
  const m = memory[active];

  const forms = {
    compound: () => html`
      <div class="field-row">
        ${field('initial', '처음 넣는 돈', m.initial, { unit: '원' })}
        ${field('monthly', '매달 적립액', m.monthly, { unit: '원' })}
      </div>
      <div class="field-row">
        ${field('rate', '연 수익률', m.rate, { unit: '%' })}
        ${field('years', '기간', m.years, { unit: '년' })}
      </div>`,
    valuation: () => html`
      <h2>주가·EPS·BPS로 계산</h2>
      <div class="field-row">
        ${field('price', '주가', m.price, { unit: '원' })}
        ${field('eps', 'EPS(주당순이익)', m.eps, { unit: '원' })}
        ${field('bps', 'BPS(주당순자산)', m.bps, { unit: '원' })}
      </div>
      <h2>둘을 알면 하나를 역산</h2>
      <div class="field-row">
        ${field('per', 'PER', m.per, { unit: '배' })}
        ${field('pbr', 'PBR', m.pbr, { unit: '배' })}
        ${field('roe', 'ROE', m.roe, { unit: '%' })}
      </div>
      <details class="more"><summary>순이익·자본으로 ROE 구하기</summary>
        <div class="field-row">
          ${field('netIncome', '순이익', m.netIncome, { unit: '원' })}
          ${field('equity', '자본', m.equity, { unit: '원' })}
        </div>
      </details>`,
    dividend: () => html`
      <div class="field-row">
        ${field('price', '주가', m.price, { unit: '원' })}
        ${field('dps', '1주당 배당금(연간)', m.dps, { unit: '원' })}
      </div>
      <div class="field-row">
        ${field('shares', '보유 수량', m.shares, { unit: '주, 선택' })}
        ${field('tax', '세율', m.tax, { unit: '%', hint: '기준: 2026년 국내 배당소득세 15.4%, 변경될 수 있음' })}
      </div>`,
    avgcost: () => html`
      <div class="field-row">
        ${field('qty', '지금 보유 수량', m.qty, { unit: '주' })}
        ${field('avgPrice', '지금 평단가', m.avgPrice, { unit: '원' })}
      </div>
      <div class="field-row">
        ${field('addQty', '추가 매수 수량', m.addQty, { unit: '주' })}
        ${field('addPrice', '추가 매수 가격', m.addPrice, { unit: '원' })}
      </div>`,
  };

  setHtml(page, html`<div class="calc">
    <header class="page-head"><h1>🧮 계산기</h1></header>
    <div class="segmented" role="group" aria-label="계산기 종류">
      ${KINDS.map(([k, label]) => html`<a class="btn-seg ${active === k ? 'on' : ''}" href="#/calc/${k}" ${active === k ? raw('aria-current="page"') : ''}>${label}</a>`)}
    </div>
    <form class="card form" data-kind="${active}" novalidate>${forms[active]()}</form>
    <section class="card" data-role="result" aria-live="polite"></section>
    ${links.length ? html`<p class="hint">📘 이 공식은 ${links.map((l, i) => html`${i ? ', ' : ''}${l.date
      ? html`<a href="#/lesson/${l.date}">${l.no}강 ${l.title}${l.sample ? '(샘플)' : ''}</a>`
      : html`<a href="#/curriculum">${l.no}강 ${l.title}</a>`}`)}에서 ${links.some((l) => l.date) ? '배워요' : '배울 예정이에요'}.</p>` : ''}
    <p class="disclaimer">계산 결과는 입력한 가정에 따른 예시이며 실제 수익을 보장하지 않습니다. 교육용 정보이며 투자 권유가 아닙니다.</p>
  </div>`);

  const form = page.querySelector('form');
  const out = page.querySelector('[data-role="result"]');
  const read = (name) => parseInputNumber(form.elements[name]?.value ?? '');

  const renderers = {
    compound() {
      const initial = read('initial') ?? 0;
      const monthly = read('monthly') ?? 0;
      const rate = read('rate');
      const years = read('years');
      if (rate === null || years === null || years <= 0 || years > 60 || initial < 0 || monthly < 0 || rate < -50 || rate > 50) {
        return html`<p class="hint">금액은 0 이상, 수익률은 -50~50%, 기간은 1~60년으로 넣어 주세요.</p>`;
      }
      const r = compound({ initial, monthly, annualRatePct: rate, years });
      return html`
        <div class="result-grid">
          ${item('최종 금액', html`<span class="num">${won(r.finalValue)}</span>`, 'main')}
          ${item('넣은 원금', html`<span class="num">${won(r.principal)}</span>`)}
          ${item(r.profit >= 0 ? '수익' : '손실', html`<span class="num">${won(Math.abs(r.profit))}</span>`)}
        </div>
        <p class="assumption">정확한 값: ${wonExact(r.finalValue)} (원금 ${wonExact(r.principal)})</p>
        ${raw(compoundChartSvg(r.yearly))}
        <div class="legend"><span><i class="l-principal"></i>원금</span><span><i class="l-profit"></i>수익</span></div>
        <p class="assumption">가정: 연 수익률을 12로 나눠 매달 복리로 적용하고, 적립금은 매달 초에 넣습니다. 세금·수수료·물가는 반영하지 않았고, 실제 수익률은 해마다 달라집니다.</p>
        <details class="more"><summary>연도별 표 보기</summary>
          <div class="table-wrap"><table class="simple">
            <thead><tr><th>연차</th><th>원금</th><th>평가 금액</th><th>수익</th></tr></thead>
            <tbody>${r.yearly.map((y) => html`<tr><td>${fmtNum(y.year, 1)}년</td><td>${won(y.principal)}</td><td>${won(y.value)}</td><td>${won(y.profit)}</td></tr>`)}</tbody>
          </table></div>
        </details>`;
    },
    valuation() {
      const v = valuation({ price: read('price'), eps: read('eps'), bps: read('bps'), per: read('per'), pbr: read('pbr'), roe: read('roe') });
      const extraRoe = roeFromTotals(read('netIncome'), read('equity'));
      const given = ['price', 'eps', 'bps', 'per', 'pbr', 'roe'].filter((k) => read(k) !== null).length;
      if (given < 2 && extraRoe === null) return html`<p class="hint">값을 두 개 이상 넣으면 나머지를 계산해 드려요. 예) 주가 50,000 · EPS 4,000 → PER 12.5배</p>`;
      const show = (x, unit, digits) => (x === null ? '–' : `${fmtNum(x, digits)}${unit}`);
      return html`
        <div class="result-grid">
          ${item('PER', html`<span class="num">${show(v.per, '배', 2)}</span>`, 'main')}
          ${item('PBR', html`<span class="num">${show(v.pbr, '배', 2)}</span>`, 'main')}
          ${item('ROE', html`<span class="num">${show(v.roe, '%', 2)}</span>`, 'main')}
          ${item('주가', html`<span class="num">${show(v.price, '원', 0)}</span>`)}
          ${item('EPS', html`<span class="num">${show(v.eps, '원', 0)}</span>`)}
          ${item('BPS', html`<span class="num">${show(v.bps, '원', 0)}</span>`)}
          ${extraRoe !== null ? item('ROE(순이익 ÷ 자본)', html`<span class="num">${fmtNum(extraRoe, 2)}%</span>`) : ''}
        </div>
        ${v.notes.map((n) => html`<p class="notice warn">${n}</p>`)}
        <p class="assumption">PER = 주가 ÷ EPS · PBR = 주가 ÷ BPS · ROE = EPS ÷ BPS = PBR ÷ PER. 숫자 하나로 싸다·비싸다를 판단할 수는 없어요. 같은 업종, 그 회사의 과거와 함께 보세요.</p>`;
    },
    dividend() {
      const r = dividend({ price: read('price'), dps: read('dps'), taxRatePct: read('tax') ?? 15.4, shares: read('shares') });
      if (!r) return html`<p class="hint">주가와 1주당 배당금을 넣어 주세요. 예) 주가 50,000 · 배당금 2,000 → 4%</p>`;
      return html`
        <div class="result-grid">
          ${item('배당수익률(세전)', html`<span class="num">${fmtNum(r.yieldPct, 2)}%</span>`, 'main')}
          ${item('배당수익률(세후)', html`<span class="num">${fmtNum(r.netYieldPct, 2)}%</span>`, 'main')}
          ${item('1주당 세후 배당금', html`<span class="num">${fmtNum(r.netDps, 0)}원</span>`)}
          ${item('1주당 세금', html`<span class="num">${fmtNum(r.taxPerShare, 0)}원</span>`)}
          ${r.gross !== null ? item('받는 배당금(세전)', html`<span class="num">${won(r.gross)}</span>`) : ''}
          ${r.net !== null ? item('받는 배당금(세후)', html`<span class="num">${won(r.net)}</span>`) : ''}
        </div>
        <p class="assumption">배당수익률 = 1주당 배당금 ÷ 주가 × 100. 세율 기준: 2026년 국내 배당소득세 15.4%(소득세 14% + 지방소득세 1.4%)이며 변경될 수 있고, 계좌 종류(ISA·연금)나 해외 주식에 따라 달라집니다. 기본값은 설정에서 바꿀 수 있어요.</p>`;
    },
    avgcost() {
      const r = avgCost({ qty: read('qty') ?? 0, avgPrice: read('avgPrice') ?? 0, addQty: read('addQty') ?? 0, addPrice: read('addPrice') ?? 0 });
      if (!r || (read('addQty') ?? 0) <= 0) return html`<p class="hint">보유 수량·평단가와 추가 매수 수량·가격을 넣어 주세요.</p>`;
      const dir = r.changePct === null ? '' : r.changePct > 0 ? 'up' : r.changePct < 0 ? 'down' : '';
      const arrow = r.changePct === null ? '' : r.changePct > 0 ? '▲' : r.changePct < 0 ? '▼' : '';
      return html`
        <div class="result-grid">
          ${item('새 평단가', html`<span class="num">${fmtNum(r.newAvg, 0)}원</span>`, 'main')}
          ${item('평단가 변화', html`<span class="num value ${dir}">${r.changePct === null ? '–' : `${arrow}${fmtNum(Math.abs(r.changePct), 2)}%`}</span>`)}
          ${item('총 수량', html`<span class="num">${fmtNum(r.totalQty, 4)}주</span>`)}
          ${item('총 매입 금액', html`<span class="num">${won(r.totalCost)}</span>`)}
        </div>
        <p class="assumption">새 평단가 = (보유 수량 × 평단가 + 추가 수량 × 추가 가격) ÷ 총 수량. 수수료·세금은 반영하지 않았어요. 평단가가 낮아진다고 손실이 사라지는 것은 아니에요.</p>`;
    },
  };

  const update = () => {
    for (const el of form.elements) if (el.name && el.name in m) m[el.name] = el.value;
    setHtml(out, renderers[active]());
  };
  form.addEventListener('input', update);
  form.addEventListener('submit', (e) => e.preventDefault());
  update();
}
