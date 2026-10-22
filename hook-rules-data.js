/* hook_rules.json from kanji-data (HOOK_RULES.md), wrapped for the browser. */
window.HOOK_RULES_DATA = {
 "version": 1,
 "doc": "HOOK_RULES.md",
 "minLength": 12.0,
 "fit": {
  "margin": {
   "turn": 3,
   "lateral": 0.005,
   "share": 0.05
  },
  "data": "full_coverage_correct + sloppy_correct strokes of samples the app accepts (no rejects allowed); full_coverage_wrong"
 },
 "categories": {
  "bend": {
   "rationale": "Corner strokes (㇕, ㇇, …) turn earlier; only the final tail is measured, against the reference's own tail.",
   "goodStrokes": 7626,
   "added": {
    "measure": "final15",
    "sign": 1,
    "minTurnGap": 23,
    "minLateralGap": 0.105
   },
   "addedFit": {
    "caught": 22,
    "of": 39
   }
  },
  "dot": {
   "rationale": "Dots are short and pen noise turns them a lot: no rule (left to the app).",
   "goodStrokes": 9014
  },
  "hookCorner": {
   "rationale": "Corner hooks (月, 刀, kvg ㇆): ink must turn toward the hook side at the end.",
   "goodStrokes": 2198,
   "dropped": {
    "maxTurnShare": 0.05,
    "maxLateralShare": 0.1
   },
   "droppedFit": {
    "caught": 6,
    "of": 61
   },
   "partial": [
    {
     "feature": "hookShare",
     "op": "<",
     "value": 0.45
    },
    {
     "feature": "reachPerTurn",
     "op": ">=",
     "value": 1.7
    }
   ],
   "partialFit": {
    "caught": 2,
    "of": 16,
    "data": "kanji-qa wrong_shapes half-hook cases"
   }
  },
  "hookCurve": {
   "rationale": "Curved hooks (心 ㇟/㇂/㇁…): ink must curl toward the hook side.",
   "goodStrokes": 1507,
   "dropped": {
    "maxTurnShare": 0.075,
    "maxLateralShare": 0.275
   },
   "droppedFit": {
    "caught": 15,
    "of": 81
   }
  },
  "hookFaint": {
   "rationale": "Hook-typed in KanjiVG but the geometry shows almost no hook (㇖ in 学, ㇆ in 曜): writers vary, no rule.",
   "goodStrokes": 413
  },
  "hookHorizontal": {
   "rationale": "Horizontal hooks (冖 ㇖) with a visible KanjiVG hook.",
   "goodStrokes": 552,
   "dropped": {
    "maxTurnShare": 0.15,
    "maxLateralShare": 0.35
   },
   "droppedFit": {
    "caught": 31,
    "of": 39
   },
   "partial": [
    {
     "feature": "turn15",
     "op": "<",
     "value": 0.6
    },
    {
     "feature": "flickTurn",
     "op": "<",
     "value": 0.8
    }
   ],
   "partialFit": {
    "caught": 2,
    "of": 2,
    "data": "kanji-qa wrong_shapes half-hook cases"
   }
  },
  "hookVertical": {
   "rationale": "Vertical hooks (亅, kvg ㇚): ink must turn toward the hook side.",
   "goodStrokes": 1064,
   "partial": [
    {
     "feature": "hookShare",
     "op": "<",
     "value": 1.2
    },
    {
     "feature": "reachPerTurn",
     "op": ">=",
     "value": 1.75
    }
   ],
   "partialFit": {
    "caught": 5,
    "of": 10,
    "data": "kanji-qa wrong_shapes half-hook cases"
   }
  },
  "horizontal": {
   "rationale": "Horizontal stops (一, 二, top bars) never end in a tail in KanjiVG; a tail is an added hook.",
   "goodStrokes": 22307,
   "added": {
    "measure": "final15",
    "sign": 1,
    "minTurnGap": 23,
    "minLateralGap": 0.09
   },
   "addedFit": {
    "caught": 26,
    "of": 33
   }
  },
  "kana": {
   "rationale": "Kana strokes without a hook (untyped in KanjiVG): same added-hook test as kanji, fitted separately.",
   "goodStrokes": 1152
  },
  "kanaHook": {
   "rationale": "Kana strokes with a geometric hook (き, さ, り): dropped-hook test, fitted separately.",
   "goodStrokes": 207,
   "dropped": {
    "maxTurnShare": 0.25,
    "maxLateralShare": 0.5
   },
   "droppedFit": {
    "caught": 13,
    "of": 17
   }
  },
  "leftSweep": {
   "rationale": "Left sweeps (harai ㇒) taper along their own curve; a turn back against the curve is an added hook.",
   "goodStrokes": 11995,
   "added": {
    "measure": "tip",
    "sign": 1,
    "minTurnGap": 45,
    "minLateralGap": 0.0
   },
   "addedFit": {
    "caught": 14,
    "of": 24
   }
  },
  "rightSweep": {
   "rationale": "Right sweeps (㇏) flatten at the end; a sharp upturn is an added hook.",
   "goodStrokes": 2712,
   "added": {
    "measure": "tip",
    "sign": 0,
    "minTurnGap": 43,
    "minLateralGap": 0.06
   },
   "addedFit": {
    "caught": 85,
    "of": 101
   }
  },
  "rise": {
   "rationale": "Rising ticks (㇀, left of 地/河) end in a flick by nature; no hookAdded samples, no rule unless fitted.",
   "goodStrokes": 1698
  },
  "vertical": {
   "rationale": "Vertical stops (tome, 十 1st down-stroke in 中) end straight; hooked verticals are typed ㇚ and are in 'hook'.",
   "goodStrokes": 14605,
   "added": {
    "measure": "tip",
    "sign": 0,
    "minTurnGap": 44,
    "minLateralGap": 0.0025
   },
   "addedFit": {
    "caught": 12,
    "of": 21
   }
  }
 }
};
