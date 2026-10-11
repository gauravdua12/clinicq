import { TEMPLATES, type TemplateName } from "./templates";

// Exact text submitted to Meta for each template (docs/WHATSAPP_INTEGRATION.md §5).
// UTILITY wording: transactional, no offers or promotion. {{n}} are positional variables.

export interface TemplateText {
  body: string;
  examples: string[];
  buttons?: { type: "QUICK_REPLY"; text: string }[] | { type: "PHONE_NUMBER"; text: string; phone: string }[];
}

type Lang = "en" | "hi";
const qr = (...t: string[]) => t.map((text) => ({ type: "QUICK_REPLY" as const, text }));

export const TEMPLATE_TEXT: Record<Exclude<TemplateName, "staff_login_otp">, Record<Lang, TemplateText>> = {
  appointment_confirmed: {
    en: { body: "Your appointment is confirmed.\n{{1}}, {{2}} at {{3}}\nToken {{4}}\nLocation: {{5}}\nReply here anytime to reschedule or cancel.", examples: ["Sunita", "Sat 10 Oct", "6:10 PM", "A-4", "Sector 15, Gurugram"], buttons: qr("Reschedule", "Cancel") },
    hi: { body: "आपका अपॉइंटमेंट कन्फ़र्म है।\n{{1}}, {{2}} को {{3}} बजे\nटोकन {{4}}\nपता: {{5}}\nरी-शेड्यूल या कैंसल के लिए कभी भी यहाँ जवाब दें।", examples: ["सुनीता", "शनि 10 अक्टू", "6:10 PM", "A-4", "सेक्टर 15, गुरुग्राम"], buttons: qr("री-शेड्यूल", "कैंसल") },
  },
  reminder_24h: {
    en: { body: "Reminder: {{1}} ji, your appointment with {{2}} is tomorrow, {{3}} at {{4}} (Token {{5}}).", examples: ["Ramesh", "Dr. Sharma", "Mon 12 Oct", "10:20 AM", "A-2"], buttons: qr("Confirm", "Reschedule", "Cancel") },
    hi: { body: "याद दिला रहे हैं: {{1}} जी, {{2}} के साथ आपका अपॉइंटमेंट कल, {{3}} को {{4}} बजे है (टोकन {{5}})।", examples: ["रमेश", "डॉ. शर्मा", "सोम 12 अक्टू", "10:20 AM", "A-2"], buttons: qr("कन्फ़र्म", "री-शेड्यूल", "कैंसल") },
  },
  reminder_same_day: {
    en: { body: "Today at {{1}}: {{2}} ji's appointment (Token {{3}}). Doctor is {{4}}. Location: {{5}}. See you soon.", examples: ["6:10 PM", "Sunita", "A-4", "on time", "Sector 15, Gurugram"], buttons: qr("Running late", "Cancel") },
    hi: { body: "आज {{1}} बजे: {{2}} जी का अपॉइंटमेंट (टोकन {{3}})। डॉक्टर {{4}}। पता: {{5}}। जल्द मिलते हैं।", examples: ["6:10 PM", "सुनीता", "A-4", "समय पर हैं", "सेक्टर 15, गुरुग्राम"], buttons: qr("देर हो रही है", "कैंसल") },
  },
  cancelled_by_clinic: {
    en: { body: "Sorry {{1}} ji, Doctor is unavailable on {{2}}. Your {{3}} appointment is cancelled. Please pick a new time or call {{4}} for help.", examples: ["Ramesh", "Mon 12 Oct", "10:20 AM", "+91 11 4000 1234"], buttons: qr("Pick new time") },
    hi: { body: "माफ़ कीजिए {{1}} जी, {{2}} को डॉक्टर उपलब्ध नहीं हैं। आपका {{3}} का अपॉइंटमेंट कैंसल हो गया है। नया समय चुनें या {{4}} पर कॉल करें।", examples: ["रमेश", "सोम 12 अक्टू", "10:20 AM", "+91 11 4000 1234"], buttons: qr("नया समय चुनें") },
  },
  doctor_running_late: {
    en: { body: "Update for {{1}} ji: Doctor is running about {{2}} minutes behind today. Your new estimated time is around {{3}}. Thank you for your patience.", examples: ["Ramesh", "15", "7:25 PM"] },
    hi: { body: "अपडेट: {{1}} जी, आज डॉक्टर लगभग {{2}} मिनट देरी से हैं। आपका नया अंदाज़न समय {{3}} के आसपास है। धैर्य के लिए धन्यवाद।", examples: ["रमेश", "15", "7:25 PM"] },
  },
  turn_near: {
    en: { body: "Hello {{1}} ji, your turn is coming up soon. {{2}} patients ahead of you (about {{3}} min). Please stay near the reception.", examples: ["Anil", "2", "10"], buttons: qr("Check status") },
    hi: { body: "नमस्ते {{1}} जी, आपकी बारी जल्द आने वाली है। आपसे पहले {{2}} मरीज़ (लगभग {{3}} मिनट)। कृपया रिसेप्शन के पास रहिए।", examples: ["अनिल", "2", "10"], buttons: qr("मेरी बारी देखें") },
  },
  your_turn: {
    en: { body: "Hello {{1}} ji, it's your turn now. Please proceed to Doctor's cabin.", examples: ["Anil"] },
    hi: { body: "नमस्ते {{1}} जी, अब आपकी बारी है। कृपया डॉक्टर के केबिन में आइए।", examples: ["अनिल"] },
  },
  walkin_token: {
    en: { body: "Token {{1}} for {{2}} ji at {{3}}. {{4}} patients ahead, about {{5}} min.", examples: ["W-7", "Anil", "Dr. Sharma's Clinic", "3", "20"], buttons: qr("Check status") },
    hi: { body: "टोकन {{1}}: {{2}} जी, {{3}}। आपसे पहले {{4}} मरीज़, लगभग {{5}} मिनट।", examples: ["W-7", "अनिल", "डॉ. शर्मा क्लिनिक", "3", "20"], buttons: qr("मेरी बारी देखें") },
  },
  followup_due: {
    en: { body: "Hello {{1}} ji, your follow-up visit with {{2}} is due on {{3}}. Reply to book a time.", examples: ["Sunita", "Dr. Sharma", "17 Oct"], buttons: qr("Book now") },
    hi: { body: "नमस्ते {{1}} जी, {{2}} के साथ आपकी फ़ॉलो-अप विज़िट {{3}} को है। समय बुक करने के लिए जवाब दें।", examples: ["सुनीता", "डॉ. शर्मा", "17 अक्टू"], buttons: qr("अभी बुक करें") },
  },
  staff_walkin_overflow: {
    en: { body: "Walk-in list is full for the {{1}} session. {{2}} ({{3}}) is at reception. Can you adjust?", examples: ["Evening", "Anil Verma", "+91 99887 xxxxx"], buttons: qr("Yes adjust", "No") },
    hi: { body: "आज के {{1}} सेशन की वॉक-इन सूची भर गई है। {{2}} ({{3}}) रिसेप्शन पर हैं। क्या एडजस्ट कर सकते हैं?", examples: ["शाम", "अनिल वर्मा", "+91 99887 xxxxx"], buttons: qr("हाँ", "नहीं") },
  },
  daily_summary: {
    en: { body: "Today at {{1}}: {{2}} booked, {{3}} walk-ins, {{4}} completed, {{5}} no-shows, average wait {{6}} min.", examples: ["Dr. Sharma's Clinic", "18", "9", "25", "2", "14"] },
    hi: { body: "आज {{1}} में: {{2}} बुकिंग, {{3}} वॉक-इन, {{4}} पूरे, {{5}} नहीं आए, औसत इंतज़ार {{6}} मिनट।", examples: ["डॉ. शर्मा क्लिनिक", "18", "9", "25", "2", "14"] },
  },
  no_show_rebook: {
    en: { body: "We missed you today, {{1}} ji. Reply to book another time.", examples: ["Ramesh"], buttons: qr("Book again") },
    hi: { body: "आज आप नहीं आ पाए, {{1}} जी। दूसरा समय बुक करने के लिए जवाब दें।", examples: ["रमेश"], buttons: qr("फिर से बुक करें") },
  },
};

export function templateNames(): TemplateName[] {
  return Object.keys(TEMPLATES) as TemplateName[];
}
