// In-memory safety matchers. Nothing they see is stored (docs/DATA_POLICY.md §3).

const EMERGENCY_PATTERNS: RegExp[] = [
  /\bchest\s*(pain|me+i?n?\s*dard|dard)\b/i,
  /\bheart\s*attack\b/i,
  /\b(can'?t|cannot|unable to|not able to)\s*breathe?\b/i,
  /\bbreathing\s*(problem|difficulty|issue|trouble)\b/i,
  /\b(sa+ns|saans|sans)\s*(nahi|nahin|lene\s*me+i?n?\s*(dikkat|taklee?f|problem)|ruk|phool)/i,
  /\b(unconscious|fainted|faint ho|collapsed|not responding)\b/i,
  /\bbe+hosh\b/i,
  /\b(seizure|convulsion|fits?\s*(aa|aaya|aa rahe|pad))/i,
  /\b(heavy|lot of|bahut)\s*(bleeding|khoon)\b/i,
  /\bkhoon\s*(beh|bah|nikal)/i,
  /\b(accident|hit by)\b/i,
  /\b(poison|zeher|zehar|swallowed)\b/i,
  /\b(suicide|kill myself|end my life|marna chahta|marna chahti|jaan de)/i,
  /\bstroke\b/i,
  /\b(jeena|jina|jeene)\s+(nahi|nahin|nhi)\b|\bzinda\s+nahi\s+rehna\b|\bmarna\s+(hai|chahta|chahti)\b|\bkhudkushi\b|जीना\s*नहीं|आत्महत्या|\b(don'?t|do not|no longer) want to (live|be alive)|\bwant to die\b|\bend it all\b|\bself[- ]?harm\b/i,
  /\bface\s+(is\s+)?droop|\bslurred speech\b|\bcan'?t (speak|talk) properly\b|\b(one side|half body)\s+(weak|numb|not moving)/i,
  /\b(fits|convulsions?)\b/i,
  /\bchoking\b|\bcan'?t swallow\b/i,
  /\b(severe|heavy|bahut tez|tez)\s+(chest|seene)\b/i,
  /\b(very high|bahut tez|bahut zyada)\s+(fever|bukhar)\b.*\b(fits|behosh|unconscious|convuls)/i,
  /\bparalysis|lakwa\b/i,
  /सीने\s*में\s*दर्द|साँस\s*नहीं|सांस\s*नहीं|बेहोश|खून\s*बह|दौरा\s*पड़|ज़हर|जहर|दुर्घटना|एक्सीडेंट/,
];

const MEDICAL_WORDS = [
  // English
  "fever", "cough", "cold", "flu", "pain", "ache", "aching", "headache", "migraine", "sugar", "diabetes", "diabetic", "bp",
  "blood pressure", "pressure", "thyroid", "cholesterol", "medicine", "medicines", "medication", "tablet", "tablets",
  "capsule", "syrup", "injection", "dose", "dosage", "mg", "antibiotic", "paracetamol", "dolo", "crocin", "vomit",
  "vomiting", "nausea", "diarrhea", "diarrhoea", "loose motion", "loose motions", "constipation", "infection",
  "allergy", "allergic", "rash", "itching", "itchy", "swelling", "swollen", "pregnant", "pregnancy", "period",
  "periods", "cancer", "tumour", "tumor", "blood test", "x-ray", "xray", "mri", "ct scan", "ultrasound", "sonography",
  "operation", "surgery", "fracture", "injury", "injured", "burn", "bleeding", "dizziness", "dizzy", "weakness",
  "tired", "fatigue", "anxiety", "depression", "stress", "insomnia", "asthma", "piles", "kidney", "liver", "stomach",
  "acidity", "ulcer", "sinus", "throat", "sore", "ear", "eye", "tooth", "teeth", "skin", "acne", "hair fall",
  "hairfall", "obesity", "symptom", "symptoms", "sick", "unwell", "ill", "illness", "disease", "chest", "breathing",
  "covid", "dengue", "malaria", "typhoid", "jaundice", "hb", "hemoglobin", "haemoglobin", "uric", "creatinine",
  "insulin", "inhaler", "wound", "stitches", "bleed", "spotting", "uti", "urine", "stool", "motions", "palpitation",
  "seizure", "stroke", "heart", "lump", "anxious", "panic", "sleep", "can't sleep", "sweating", "choking", "cyst", "pcos", "pcod", "test results", "report says", "my report",
  // Hinglish / Hindi (roman)
  "bukhar", "bukhaar", "khansi", "khaansi", "zukam", "jukam", "nazla", "dard", "dawai", "dawa", "dawaai", "goli",
  "ulti", "dast", "kabz", "kabzi", "khujli", "sujan", "soojan", "chakkar", "kamzori", "kamjori", "neend", "pet dard",
  "gas", "jalan", "chot", "ghaav", "ghav", "khoon", "pathri", "bimar", "bimari", "beemar", "beemari", "tabiyat",
  "tabiyat kharab", "tabyat", "sardi", "jodo", "ghutne", "kamar dard", "sar dard", "sir dard", "gala kharab",
  "sans", "saans", "dhadkan", "periods", "mahina", "garbh", "ilaaj", "upchar",
  // Devanagari
  "बुखार", "खांसी", "खाँसी", "जुकाम", "दर्द", "दवा", "दवाई", "गोली", "उल्टी", "दस्त", "कब्ज", "खुजली", "सूजन",
  "चक्कर", "कमजोरी", "कमज़ोरी", "नींद", "शुगर", "बीपी", "बीमार", "बीमारी", "तबीयत", "इलाज", "चोट", "खून",
  "सर्दी", "गला", "पेट", "सांस", "साँस",
];

const MEDICAL_RE = new RegExp(
  `(^|[^\\p{L}\\p{M}])(${MEDICAL_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")).join("|")})(?=$|[^\\p{L}\\p{M}])`,
  "iu",
);

/** True when the text likely describes an emergency. In-memory only. */
export function matchesEmergency(text: string, extra: string[] = []): boolean {
  if (EMERGENCY_PATTERNS.some((re) => re.test(text))) return true;
  const lower = text.toLowerCase();
  return extra.some((k) => k.trim() && lower.includes(k.trim().toLowerCase()));
}

/**
 * Heuristic net for health details (symptoms, medicines, tests). OR-ed with the model's
 * hasNonBookingContent flag; false positives only cause a polite reminder, never a block.
 */
export function mentionsHealthDetails(text: string): boolean {
  // "report dikhani hai" / "show reports" is a visit type, not health content.
  const cleaned = text.replace(/\b(show|bring|dikhan[ai]|dikhane|dikhana|lekar|le kar)\s+(my\s+)?reports?\b/gi, " ")
    .replace(/\breports?\s+(dikhan[ai]|dikhane|dikhana|show)\b/gi, " ");
  return MEDICAL_RE.test(cleaned) || matchesEmergency(text);
}
