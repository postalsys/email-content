/**
 * Language estimation.
 *
 * Deliberately small and dependency free. This is an estimate used for stratified sampling and for
 * reporting metrics per language, never for a classification decision. A wrong guess costs a
 * slightly skewed sample, nothing more, which is why a stopword scorer is preferred over pulling in
 * a model.
 *
 * Two stages: script detection first, because a Cyrillic or CJK body is unambiguous and cheap to
 * spot, then stopword frequency for Latin script languages.
 */

export type LanguageCode =
    'en' | 'et' | 'de' | 'fr' | 'es' | 'it' | 'pt' | 'nl' | 'sv' | 'fi' | 'pl' | 'ru' | 'zh' | 'ja' | 'ko' | 'ar' | 'el' | 'he' | 'unknown';

export interface LanguageEstimate {
    lang: LanguageCode;
    /** Share of sampled tokens that matched the winning language's stopword list. */
    score: number;
}

/**
 * Stopword lists. Kept short on purpose: the most frequent function words carry nearly all of the
 * discriminative power, and long lists mostly add overlap between related languages.
 */
const STOPWORDS: Record<string, readonly string[]> = {
    en: [
        'the',
        'and',
        'you',
        'that',
        'for',
        'with',
        'this',
        'have',
        'not',
        'are',
        'was',
        'but',
        'from',
        'they',
        'will',
        'would',
        'there',
        'their',
        'what',
        'about'
    ],
    et: ['ja', 'on', 'ei', 'et', 'see', 'ka', 'kui', 'aga', 'mis', 'oma', 'ning', 'siis', 'ole', 'seda', 'kas', 'nii', 'veel', 'ta', 'ma', 'või'],
    de: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'ich', 'sie', 'mit', 'den', 'von', 'für', 'auf', 'wir', 'auch', 'dem', 'ein', 'eine', 'aber', 'noch'],
    fr: ['les', 'des', 'est', 'une', 'que', 'pour', 'dans', 'pas', 'vous', 'sur', 'avec', 'nous', 'plus', 'par', 'mais', 'ils', 'ce', 'au', 'du', 'je'],
    es: ['que', 'los', 'las', 'del', 'por', 'con', 'para', 'una', 'como', 'más', 'pero', 'sus', 'este', 'esta', 'son', 'muy', 'ser', 'sin', 'sobre', 'todo'],
    it: ['che', 'per', 'con', 'del', 'non', 'una', 'sono', 'della', 'come', 'più', 'anche', 'nel', 'alla', 'ma', 'si', 'da', 'gli', 'questo', 'essere', 'ho'],
    pt: [
        'que',
        'não',
        'com',
        'para',
        'uma',
        'dos',
        'das',
        'por',
        'mais',
        'como',
        'mas',
        'foi',
        'ele',
        'ser',
        'você',
        'está',
        'pelo',
        'isso',
        'quando',
        'muito'
    ],
    nl: ['het', 'een', 'van', 'de', 'is', 'dat', 'niet', 'en', 'op', 'te', 'zijn', 'voor', 'met', 'maar', 'ook', 'aan', 'er', 'dan', 'wij', 'heeft'],
    sv: ['och', 'att', 'det', 'som', 'en', 'är', 'på', 'för', 'med', 'den', 'har', 'inte', 'om', 'jag', 'men', 'de', 'till', 'kan', 'vi', 'ett'],
    fi: ['on', 'ja', 'ei', 'se', 'että', 'ovat', 'ole', 'kun', 'niin', 'mutta', 'voi', 'tai', 'jos', 'sen', 'me', 'te', 'hän', 'kuin', 'vain', 'myös'],
    pl: ['nie', 'się', 'jest', 'że', 'do', 'na', 'to', 'jak', 'ale', 'dla', 'przez', 'tego', 'lub', 'oraz', 'tym', 'przy', 'być', 'ma', 'już', 'tylko']
};

const SCRIPT_RANGES: readonly { lang: LanguageCode; regex: RegExp }[] = [
    { lang: 'ru', regex: /[Ѐ-ӿ]/g },
    { lang: 'el', regex: /[Ͱ-Ͽ]/g },
    { lang: 'he', regex: /[֐-׿]/g },
    { lang: 'ar', regex: /[؀-ۿ]/g },
    { lang: 'ko', regex: /[가-힯ᄀ-ᇿ]/g },
    { lang: 'ja', regex: /[぀-ヿ]/g },
    { lang: 'zh', regex: /[一-鿿]/g }
];

/** Minimum tokens needed before a Latin script guess is trusted. */
const MIN_TOKENS = 12;

/** Minimum matched share before a guess is returned rather than "unknown". */
const MIN_SCORE = 0.06;

/**
 * Estimate the language of a body of text.
 *
 * @param text plain text. Only the first 20k characters are inspected, which is ample and keeps the
 *   cost bounded on newsletters and digests.
 */
export function estimateLanguage(text: string): LanguageEstimate {
    const sample = text.length > 20000 ? text.slice(0, 20000) : text;
    if (!sample.trim()) {
        return { lang: 'unknown', score: 0 };
    }

    // Script detection first. A body with a meaningful share of non Latin letters is decided here.
    const letters = sample.replace(/[^\p{L}]/gu, '').length;
    if (letters > 20) {
        for (const { lang, regex } of SCRIPT_RANGES) {
            regex.lastIndex = 0;
            const matches = sample.match(regex);
            if (matches && matches.length / letters > 0.2) {
                return { lang, score: matches.length / letters };
            }
        }
    }

    const tokens = sample
        .toLowerCase()
        .split(/[^\p{L}']+/u)
        .filter(token => token.length > 1);
    if (tokens.length < MIN_TOKENS) {
        return { lang: 'unknown', score: 0 };
    }

    const counts = new Map<string, number>();
    for (const token of tokens) {
        counts.set(token, (counts.get(token) || 0) + 1);
    }

    let bestLang: LanguageCode = 'unknown';
    let bestScore = 0;
    for (const [lang, words] of Object.entries(STOPWORDS)) {
        let hits = 0;
        for (const word of words) {
            hits += counts.get(word) || 0;
        }
        const score = hits / tokens.length;
        if (score > bestScore) {
            bestScore = score;
            bestLang = lang as LanguageCode;
        }
    }

    return bestScore >= MIN_SCORE ? { lang: bestLang, score: bestScore } : { lang: 'unknown', score: bestScore };
}
