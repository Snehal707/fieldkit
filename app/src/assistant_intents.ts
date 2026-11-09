// Built-in intent prototypes for the offline assistant (English and Hindi). A workspace can add its own examples
// (manifest.intents) written by Hermes for that job. Intent = nearest prototype by meaning (multilingual embeddings).
// These are the "train" side; tests/eval/assistant_set.json holds separate held-out questions.

export type Intent = "explain_issue" | "what_next" | "why" | "is_it_safe" | "how_to" | "troubleshoot" | "define_term"
  | "check_requirement" | "explain_report" | "compare_to_previous" | "translate";

export const INTENT_EXAMPLES: Record<Intent, { en: string[]; hi: string[] }> = {
  explain_issue: {
    en: ["Explain issue 2", "Tell me about the first problem", "What does this issue mean?", "Explain that finding",
      "What is the problem with the guard?", "Describe the second issue in detail"],
    hi: ["दूसरी समस्या समझाइए", "पहली समस्या के बारे में बताइए", "इस मुद्दे का क्या मतलब है?", "यह समस्या क्या है?"],
  },
  what_next: {
    en: ["What should I do next?", "What do I do first?", "Which action comes first?", "What are the next steps?",
      "Now what?", "What should I do about it?"],
    hi: ["आगे क्या करूँ?", "पहले क्या करना है?", "अगला कदम क्या है?", "मुझे अब क्या करना चाहिए?"],
  },
  why: {
    en: ["Why?", "Why is that the decision?", "Why do I need to do that?", "What is the reason for this?",
      "Why is it rated high risk?", "Explain why"],
    hi: ["क्यों?", "ऐसा निर्णय क्यों?", "इसका कारण क्या है?", "मुझे ऐसा क्यों करना है?"],
  },
  is_it_safe: {
    en: ["Is it safe to use?", "Can I keep running the machine?", "Is it dangerous?", "Can we continue working?",
      "Should I stop using it?", "Is the milk safe to accept?"],
    hi: ["क्या यह सुरक्षित है?", "क्या मशीन चलाना जारी रख सकते हैं?", "क्या यह खतरनाक है?", "क्या इसे रोकना चाहिए?"],
  },
  how_to: {
    en: ["How do I do this?", "Show me the procedure", "How do I check the alignment?", "Steps to lock out the machine",
      "Guide me through the test", "How is this done properly?"],
    hi: ["यह कैसे करूँ?", "प्रक्रिया बताइए", "जाँच कैसे करें?", "कदम दर कदम बताइए"],
  },
  troubleshoot: {
    en: ["What could be causing this?", "Help me find the cause", "Why is it making that noise?", "It is overheating, what now?",
      "Something is wrong, diagnose it", "Possible causes of the problem"],
    hi: ["इसका कारण क्या हो सकता है?", "कारण खोजने में मदद करें", "यह आवाज़ क्यों कर रहा है?", "गड़बड़ी का पता कैसे लगाएँ?"],
  },
  define_term: {
    en: ["What is lockout?", "What does this word mean?", "Define chlorosis", "What is a coupling?", "Meaning of the term"],
    hi: ["इस शब्द का अर्थ क्या है?", "कपलिंग क्या होता है?", "परिभाषा बताइए", "इसका मतलब क्या है?"],
  },
  check_requirement: {
    en: ["What is the limit for this?", "What does the standard say?", "Is this within the rules?", "What is the minimum allowed?",
      "What is the regulation?", "Is this value acceptable?"],
    hi: ["इसकी सीमा क्या है?", "मानक क्या कहता है?", "क्या यह नियमों के भीतर है?", "न्यूनतम अनुमति क्या है?"],
  },
  explain_report: {
    en: ["Explain the report", "What does the Hermes report say?", "Give me the summary", "What was the result of the analysis?",
      "Read me the decision"],
    hi: ["रिपोर्ट समझाइए", "हर्मीस रिपोर्ट क्या कहती है?", "सारांश बताइए", "विश्लेषण का परिणाम क्या रहा?"],
  },
  compare_to_previous: {
    en: ["Compare with the previous inspection", "Has it improved since last time?", "What changed from before?",
      "Is it getting worse?", "Show the history for this asset"],
    hi: ["पिछली जाँच से तुलना करें", "क्या पिछली बार से सुधार हुआ है?", "पहले से क्या बदला?", "क्या यह बिगड़ रहा है?"],
  },
  translate: {
    en: ["Translate this", "Say it in Hindi", "Translate to English", "Can you give this in my language?"],
    hi: ["इसका अनुवाद करें", "हिंदी में बताइए", "अंग्रेज़ी में अनुवाद करें"],
  },
};

/** Words that mark an intent strongly (used when the embedding model is not installed, and as a tie-breaker). */
export const INTENT_CUES: Partial<Record<Intent, RegExp>> = {
  why: /^(why|क्यों)\b|\bwhy\b|क्यों/i,
  what_next: /\b(next|first|now what|should i do)\b|आगे|अगला|पहले क्या/i,
  is_it_safe: /\b(safe|dangerous|keep (running|using)|continue)\b|सुरक्षित|खतरनाक/i,
  how_to: /\b(how (do|to|is)|steps?|procedure|guide me)\b|कैसे|प्रक्रिया|कदम/i,
  troubleshoot: /\b(caus|diagnos|noise|overheat|wrong)\w*/i,
  define_term: /\b(what (is|does) .{1,25} (mean|stand for)|meaning|define)\b|अर्थ|मतलब|परिभाषा/i,
  check_requirement: /\b(limit|standard|minimum|maximum|regulation|allowed|within)\b|सीमा|मानक|न्यूनतम|नियम/i,
  explain_report: /\breport|summar|analysis|conclu/i,
  compare_to_previous: /\b(compare|previous|last (time|week|inspection)|history|improv|worse)\b|पिछल|तुलना/i,
  translate: /\btranslat|in (hindi|english)\b|अनुवाद|हिंदी में|अंग्रेज़ी में/i,
  explain_issue: /\b(issue|problem|finding)\b|समस्या|मुद्द/i,
};
