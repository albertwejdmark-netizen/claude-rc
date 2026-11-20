"""Målmodell (Dixon–Coles) och marknadsberäkningar.

Varje lag får en anfalls- och en försvarsstyrka som skattas från lagets matcher, där
nyare matcher väger tyngre (halveringstid HALF_LIFE dagar). Där xG finns blandas
målen med xG eftersom xG säger mer om framtida mål än själva resultatet. Lag med få
matcher dras mot en startgissning (nyuppflyttade lag lite svagare, nedflyttade lite
starkare).

  förväntade hemmamål  = exp(c + hemmafördel + anfall[hemma] + försvar[borta])
  förväntade bortamål  = exp(c + anfall[borta] + försvar[hemma])

Från de förväntade målen räknas en resultatmatris (Poisson med Dixon–Coles-justering
av 0–0, 1–0, 0–1 och 1–1) och ur den alla målmarknader.

Spelbolagens odds räknas också om till förväntade mål ("marknadens" mål) och den
slutliga bedömningen är ett vägt geometriskt medel av modellen och marknaden.
Vikten väljs i backtestet (build.py) som den som gav bäst träffsäkerhet.
"""

import math

import numpy as np

HALF_LIFE = 180.0   # dagar
XG_WEIGHT = 0.6     # andel xG (eller skott på mål-skattning) i målmåttet
PRIOR_K = 5.0       # hur många "matcher" startgissningen väger
RHO = -0.06         # Dixon–Coles-justering för låga resultat
NMAX = 11           # 0..10 mål per lag


class Fit:
    def __init__(self, teams, att, de, home, c, n_eff):
        self.teams = teams
        self.idx = {t: i for i, t in enumerate(teams)}
        self.att, self.de, self.home, self.c = att, de, home, c
        self.n_eff = n_eff

    def lambdas(self, h, a, prior=None):
        """Förväntade mål (hemma, borta). Okända lag får startgissningen."""
        prior = prior or {}

        def get(t):
            if t in self.idx:
                i = self.idx[t]
                return self.att[i], self.de[i]
            pa = prior.get(t, -0.15)
            return pa, -pa

        ah, dh = get(h)
        aa, da = get(a)
        return math.exp(self.c + self.home + ah + da), math.exp(self.c + aa + dh)

    def rating(self, t):
        """Anfall, försvar (förväntade mål för/emot mot ett snittlag på neutral plan)."""
        if t not in self.idx:
            return None
        i = self.idx[t]
        base = self.c + self.home / 2
        return math.exp(base + self.att[i]), math.exp(base + self.de[i])


def fit(rows, ref_ordinal, prior=None, half_life=HALF_LIFE, xg_weight=XG_WEIGHT, k=PRIOR_K, init=None, iters=60):
    """rows: lista av (datum-ordinal, hemma, borta, hemmamål, bortamål, hxg, axg).
    hxg/axg kan vara riktig xG eller en skattning från skott på mål (se build.rows_for_fit).
    prior: {lag: anfallsgissning (log)}; försvaret får motsatt tecken."""
    prior = prior or {}
    teams = sorted({r[1] for r in rows} | {r[2] for r in rows})
    if len(rows) < 20 or len(teams) < 4:
        return None
    ix = {t: i for i, t in enumerate(teams)}
    T = len(teams)
    H = np.array([ix[r[1]] for r in rows])
    A = np.array([ix[r[2]] for r in rows])
    gh = np.array([r[3] for r in rows], float)
    ga = np.array([r[4] for r in rows], float)
    xh = np.array([r[5] if r[5] is not None else np.nan for r in rows], float)
    xa = np.array([r[6] if r[6] is not None else np.nan for r in rows], float)
    has = ~np.isnan(xh) & ~np.isnan(xa)
    yh = np.where(has, (1 - xg_weight) * gh + xg_weight * np.nan_to_num(xh), gh)
    ya = np.where(has, (1 - xg_weight) * ga + xg_weight * np.nan_to_num(xa), ga)
    age = ref_ordinal - np.array([r[0] for r in rows], float)
    w = np.exp(-math.log(2) / half_life * np.maximum(age, 0))
    pa = np.array([prior.get(t, 0.0) for t in teams])
    pd = -pa

    if init is not None:
        att = np.array([init.att[init.idx[t]] if t in init.idx else pa[i] for i, t in enumerate(teams)])
        de = np.array([init.de[init.idx[t]] if t in init.idx else pd[i] for i, t in enumerate(teams)])
        home, c = init.home, init.c
    else:
        att, de = pa.copy(), pd.copy()
        home = 0.25
        c = math.log(max(0.3, (w * (yh + ya)).sum() / (2 * w.sum()))) - home / 2

    for _ in range(iters):
        b = math.exp(c + home / 2)
        num = np.bincount(H, w * yh, T) + np.bincount(A, w * ya, T) + k * b * np.exp(pa)
        den = np.bincount(H, w * np.exp(c + home + de[A]), T) + np.bincount(A, w * np.exp(c + de[H]), T) + k * b
        att_new = np.log(num / den)
        num = np.bincount(A, w * yh, T) + np.bincount(H, w * ya, T) + k * b * np.exp(pd)
        den = np.bincount(A, w * np.exp(c + home + att_new[H]), T) + np.bincount(H, w * np.exp(c + att_new[A]), T) + k * b
        de_new = np.log(num / den)
        home = math.log((w * yh).sum() / (w * np.exp(c + att_new[H] + de_new[A])).sum())
        c = math.log((w * (yh + ya)).sum() / (w * (np.exp(home + att_new[H] + de_new[A]) + np.exp(att_new[A] + de_new[H]))).sum())
        ma, md = att_new.mean(), de_new.mean()
        att_new -= ma
        de_new -= md
        c += ma + md
        delta = max(np.abs(att_new - att).max(), np.abs(de_new - de).max())
        att, de = att_new, de_new
        if delta < 1e-5:
            break
    return Fit(teams, att, de, home, c, float(w.sum()))


# ---------------------------------------------------------------- resultatmatris

def _pois(lam, n=NMAX):
    """lam: array (N,) -> (N, n)"""
    lam = np.asarray(lam, float)[:, None]
    k = np.arange(n)[None, :]
    logf = np.array([math.lgamma(i + 1) for i in range(n)])[None, :]
    return np.exp(k * np.log(np.maximum(lam, 1e-9)) - lam - logf)


def matrix(lh, la, rho=RHO):
    """Resultatmatriser (N, n, n) med Dixon–Coles-justering, normerade."""
    lh, la = np.atleast_1d(np.asarray(lh, float)), np.atleast_1d(np.asarray(la, float))
    M = _pois(lh)[:, :, None] * _pois(la)[:, None, :]
    M[:, 0, 0] *= 1 - lh * la * rho
    M[:, 0, 1] *= 1 + lh * rho
    M[:, 1, 0] *= 1 + la * rho
    M[:, 1, 1] *= 1 - rho
    M = np.maximum(M, 0)
    return M / M.sum(axis=(1, 2), keepdims=True)


_I, _J = np.meshgrid(np.arange(NMAX), np.arange(NMAX), indexing="ij")
_HW, _DR, _AW = _I > _J, _I == _J, _I < _J
_O25 = (_I + _J) > 2.5


def basic(lh, la):
    """(pH, pD, pA, pÖver2,5) som arrayer."""
    M = matrix(lh, la)
    return (M * _HW).sum((1, 2)), (M * _DR).sum((1, 2)), (M * _AW).sum((1, 2)), (M * _O25).sum((1, 2))


def devig(odds):
    inv = [1 / o for o in odds]
    s = sum(inv)
    return [x / s for x in inv]


def market_lambdas(p1x2, pover=None, iters=12):
    """Förväntade mål som bäst återskapar marknadens sannolikheter (vektoriserat).
    p1x2: (N, 3), pover: (N,) eller None/nan där O/U saknas."""
    p1x2 = np.asarray(p1x2, float)
    N = len(p1x2)
    pover = np.full(N, np.nan) if pover is None else np.asarray(pover, float)
    has_ou = ~np.isnan(pover)
    # startgissning: totalt 2,6 mål, fördelning efter styrkeskillnad
    tot = np.where(has_ou, 2.6 + 2.0 * (np.nan_to_num(pover) - 0.5), 2.6)
    sup = 1.6 * (p1x2[:, 0] - p1x2[:, 2])
    x = np.stack([np.log(np.maximum((tot + sup) / 2, 0.15)), np.log(np.maximum((tot - sup) / 2, 0.15))], 1)

    def resid(x):
        h, d, a, o = basic(np.exp(x[:, 0]), np.exp(x[:, 1]))
        r = np.stack([h - p1x2[:, 0], a - p1x2[:, 2], d - p1x2[:, 1], np.where(has_ou, o - np.nan_to_num(pover), 0.0)], 1)
        return r

    eps = 1e-4
    for _ in range(iters):
        r = resid(x)
        J = np.empty((N, 4, 2))
        for j in range(2):
            dx = np.zeros_like(x)
            dx[:, j] = eps
            J[:, :, j] = (resid(x + dx) - r) / eps
        JT = np.transpose(J, (0, 2, 1))
        JTJ = JT @ J + 1e-6 * np.eye(2)[None]
        step = np.linalg.solve(JTJ, (JT @ r[:, :, None]))[:, :, 0]
        x = x - np.clip(step, -0.5, 0.5)
    return np.exp(x[:, 0]), np.exp(x[:, 1])


def blend(model, market, alpha):
    """Geometriskt medel av förväntade mål. alpha = modellens vikt."""
    if market is None:
        return model
    return tuple(math.exp(alpha * math.log(m) + (1 - alpha) * math.log(k)) for m, k in zip(model, market))


# ---------------------------------------------------------------- marknader

LINES = (0.5, 1.5, 2.5, 3.5, 4.5)


def goal_markets(lh, la, fh_share=None):
    """Alla målmarknader för en match: {nyckel: sannolikhet}."""
    M = matrix([lh], [la])[0]
    tot = np.zeros(2 * NMAX - 1)
    for i in range(NMAX):
        for j in range(NMAX):
            tot[i + j] += M[i, j]
    hd, ad = M.sum(1), M.sum(0)
    p = {"1": float((M * _HW).sum()), "X": float((M * _DR).sum()), "2": float((M * _AW).sum())}
    p["1X"], p["12"], p["X2"] = p["1"] + p["X"], p["1"] + p["2"], p["X"] + p["2"]
    for L in LINES:
        o = float(tot[int(L + 0.5):].sum())
        p[f"O{L}"], p[f"U{L}"] = o, 1 - o
    p["BTTS:J"] = float(1 - M[0, :].sum() - M[:, 0].sum() + M[0, 0])
    p["BTTS:N"] = 1 - p["BTTS:J"]
    for L in (0.5, 1.5, 2.5):
        p[f"H:O{L}"] = float(hd[int(L + 0.5):].sum())
        p[f"A:O{L}"] = float(ad[int(L + 0.5):].sum())
    p["H:CS"] = float(ad[0])  # hemmalaget håller nollan
    p["A:CS"] = float(hd[0])
    if fh_share:
        lf = (lh + la) * fh_share
        p["FH:O0.5"] = 1 - math.exp(-lf)
        p["FH:O1.5"] = 1 - math.exp(-lf) * (1 + lf)
    cs = sorted(((float(M[i, j]), f"{i}-{j}") for i in range(7) for j in range(7)), reverse=True)[:8]
    return p, [[s, round(q, 4)] for q, s in cs], M


def ah_ev(M, line, odds_h, odds_a):
    """Asiatiskt handikapp (line = hemmalagets handikapp). Returnerar förväntad återbetalning per krona
    och chans till hel vinst för hemma/borta."""
    n = M.shape[0]
    diff = {}
    for i in range(n):
        for j in range(n):
            diff[i - j] = diff.get(i - j, 0) + float(M[i, j])
    halves = [line - 0.25, line + 0.25] if abs(line * 4) % 2 == 1 else [line]

    def ret(side, o):
        exp_ret, pwin = 0.0, 0.0
        for d, pr in diff.items():
            r_tot, win_all = 0.0, True
            for l in halves:
                r = (d + l) if side == "H" else (-d - l)
                if r > 0:
                    r_tot += o
                elif r == 0:
                    r_tot += 1
                    win_all = False
                else:
                    win_all = False
            exp_ret += pr * r_tot / len(halves)
            if win_all:
                pwin += pr
        return exp_ret, pwin

    return {"H": ret("H", odds_h) if odds_h else None, "A": ret("A", odds_a) if odds_a else None}


def nb_over(mean, ratio, line):
    """P(X > line) för negativ binomial med varians = ratio * medel (Poisson om ratio <= 1)."""
    k_max = int(line)
    if mean <= 0:
        return 0.0
    if ratio <= 1.02:
        pk = math.exp(-mean)
        cdf = pk
        for k in range(1, k_max + 1):
            pk *= mean / k
            cdf += pk
        return max(0.0, 1 - cdf)
    p = 1 / ratio
    r = mean * p / (1 - p)
    pk = p ** r
    cdf = pk
    for k in range(1, k_max + 1):
        pk *= (k - 1 + r) / k * (1 - p)
        cdf += pk
    return max(0.0, 1 - cdf)
