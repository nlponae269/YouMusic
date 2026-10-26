"""Словари запрещённых слов: нецензурная брань, оскорбления, наркотики и зависимость, суицид.

Слова сравниваются целиком (после замены ё → е), поэтому «хлебать», «себе», «рубля»,
«застрахуй», «мудрый», «мандарин», «героиня», «сук» (ветка), «независимый» не считаются нарушением.
Фразы из нескольких слов («убью себя», «покончу с собой») ищутся отдельно.

Если словарь меняется — увеличьте VERSION: уже опубликованные треки перепроверятся сами.
"""
import re

VERSION = 2

PREFIX = (r"(?:за|на|по|от|ото|отъ|вы|у|раз|рас|разъ|до|об|обо|объ|под|подъ|пере|при|"
          r"с|со|съ|въ|вз|взъ|из|изъ|ис|не|недо|про|долбо|долба)?")

MAT = [
    rf"^{PREFIX}ху[йяеию]",
    # распознавание речи иногда склеивает слова («всёпохуй») — этот корень ищем и внутри слова
    r"(?<!стра)ху[йяеё]|(?<!стра)хуи",
    r"пизд",
    rf"^{PREFIX}еб(?:$|а|у|л|н|ош|ок|ис|ет|ут|ыв|ук|ен|ыр|ич)",
    r"^бля$|^блят|" + rf"^{PREFIX}бляд",
    r"^муда[кч]|^мудил|^мудоз|^мудач",
    r"^пид[оа]?р",
    r"^манд(?:а|ы|у|е|ой)$|^мандец|^мандав",
    r"^залуп",
    # «сука» во всех формах, но не «сук» (ветка)
    r"^с+ук(?:а|и|е|у|ой|ам|ами|ах|ин|ина|ины|ино)$|^с+уч(?:ка|ки|ке|ку|кой|ара|ары|ье)",
    r"^fuck|motherfuck|^cunt|^nigg|^bitch",
]

DRUGS = [
    r"^нарко(?!з|лог)",
    r"^кока[иі]н|^кокс(?:а|ом|у)?$|^cocain",
    r"^героин(?:а|ом|у|щик)?$|^heroin",
    r"^мефедрон|^меф(?:а|ом|у|чик)?$",
    r"амфетамин",
    r"^экстази|^мдма$|^mdma$|^ecstasy",
    r"^лсд$|^lsd$",
    r"^марихуан|^мариван|^ганж|^анаш|^гашиш|^гаш$|^weed$|^marijuana",
    r"^спайс(?:а|ом|у)?$",
    r"^закладк|^кладмен|^кладчик",
    r"^барыг",
    r"^ширя|^ширн|^шырн",
    r"^торч(?:ок|ки|ка|ков|ком)",
    r"^кетамин|^метадон|^опиу|^опиат|^морфин|^трамадол|^ксанакс|^xanax",
    r"^снюха|^занюха|^пыхн",
    r"^дурь$",
    # зависимость (но не «независимый»)
    r"^зависим",
]

SUICIDE = [
    r"^суицид|^самоубий|^самовыпил",
    r"^выпил(?:юсь|иться|ился|илась|ись|имся)$",
    r"^повес(?:иться|ился|илась|ишься|ись)$|^повешусь$|^вздерн(?:усь|уться)$",
]

# Фразы: проверяются по нескольким словам подряд
PHRASES = [
    r"\b(?:убью|убить|убей|убил|убила|убиваю|убьешь|убивать|убьем) себя\b",
    r"\bпоконч\w* с собой\b",
    r"\bвскр\w* (?:себе )?вен\w*\b",
    r"\bналож\w* на себя руки\b",
    r"\bkill myself\b",
]

_RULES = re.compile("|".join(MAT + DRUGS + SUICIDE))
_PHRASES = re.compile("|".join(PHRASES))
WORD = re.compile(r"[a-zа-яё]+", re.IGNORECASE)


def _norm(s: str) -> str:
    return s.lower().replace("ё", "е")


def is_banned(word: str) -> bool:
    return bool(_RULES.search(_norm(word)))


def banned_indices(words: list[str]) -> set[int]:
    """Номера запрещённых слов в последовательности: отдельные слова и фразы целиком."""
    clean = [_norm("".join(WORD.findall(w))) for w in words]
    out = {i for i, w in enumerate(clean) if w and _RULES.search(w)}
    # склеиваем слова в строку и помним, где начинается каждое
    starts, pos = [], 0
    for w in clean:
        starts.append(pos)
        pos += len(w) + 1
    joined = " ".join(clean)
    for m in _PHRASES.finditer(joined):
        out |= {i for i, s in enumerate(starts) if s < m.end() and s + len(clean[i]) > m.start() and clean[i]}
    return out


def banned_in(text: str) -> list[str]:
    words = WORD.findall(text or "")
    return [words[i] for i in sorted(banned_indices(words))]


def censor_text(text: str) -> tuple[str, int]:
    """Заменяет запрещённые слова и фразы звёздочками. Возвращает текст и число замен."""
    text = text or ""
    matches = list(WORD.finditer(text))
    bad = banned_indices([m.group(0) for m in matches])
    out, last = [], 0
    for i, m in enumerate(matches):
        if i in bad:
            out.append(text[last:m.start()])
            out.append("*" * len(m.group(0)))
            last = m.end()
    out.append(text[last:])
    return "".join(out), len(bad)
