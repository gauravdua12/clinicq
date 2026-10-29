import { TEMPLATES, type TemplateName } from "./templates";

// Exact text submitted to Meta for each template (docs/WHATSAPP_INTEGRATION.md §5).
// UTILITY wording: transactional, no offers or promotion. {{n}} are positional variables.

export interface TemplateText {
  body: string;
  examples: string[];
  buttons?: { type: "QUICK_REPLY"; text: string }[] | { type: "PHONE_NUMBER"; text: string; phone: string }[] | { type: "URL"; text: string; url: string; example: string[] }[];
}

type Lang = "en" | "hi";
const qr = (...t: string[]) => t.map((text) => ({ type: "QUICK_REPLY" as const, text }));
/** "{{BASE}}" is replaced with the server's public address when the template is submitted (scripts/meta). */
const payBtn = (text: string) => [{ type: "URL" as const, text, url: "{{BASE}}/pay?t={{1}}", example: ["{{BASE}}/pay?t=Xy7Kq2Lm9Pa4"] }];

export const TEMPLATE_TEXT: Record<Exclude<TemplateName, "staff_login_otp">, Record<Lang, TemplateText>> = {
  appointment_confirmed: {
    en: { body: "Booking confirmed.\nPatient: {{1}}\nDate: {{2}}\nTime: {{3}}\nToken number: {{4}}\nClinic: {{5}}\nTo reschedule or cancel this booking, tap a button below.", examples: ["Sunita", "Sat 10 Oct", "6:10 PM", "A-4", "Sector 15, Gurugram"], buttons: qr("Reschedule", "Cancel") },
    hi: { body: "आपका अपॉइंटमेंट कन्फ़र्म है।\n{{1}}, {{2}} को {{3}} बजे\nटोकन {{4}}\nपता: {{5}}\nरी-शेड्यूल या कैंसल के लिए कभी भी यहाँ जवाब दें।", examples: ["सुनीता", "शनि 10 अक्टू", "6:10 PM", "A-4", "सेक्टर 15, गुरुग्राम"], buttons: qr("री-शेड्यूल", "कैंसल") },
  },
  reminder_24h: {
    en: { body: "Hello {{1}} ji, this is a reminder of your appointment with {{2}} tomorrow, {{3}}, at {{4}}. Your token number is {{5}}. Please tap a button below to confirm, reschedule or cancel.", examples: ["Ramesh", "Dr. Sharma", "Mon 12 Oct", "10:20 AM", "A-2"], buttons: qr("Confirm", "Reschedule", "Cancel") },
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
    en: { body: "Token {{1}} has been issued for {{2}} ji at {{3}}. There are {{4}} patients ahead of you, and the expected wait is about {{5}} minutes. We will message you again when your turn is near.", examples: ["W-7", "Anil", "Dr. Sharma's Clinic", "3", "20"], buttons: qr("Check status") },
    hi: { body: "टोकन {{1}} जारी किया गया है: {{2}} जी, {{3}}। आपसे पहले {{4}} मरीज़ हैं और अनुमानित इंतज़ार लगभग {{5}} मिनट है। आपकी बारी नज़दीक आने पर हम आपको फिर से संदेश भेजेंगे।", examples: ["W-7", "अनिल", "डॉ. शर्मा क्लिनिक", "3", "20"], buttons: qr("मेरी बारी देखें") },
  },
  followup_due: {
    en: { body: "Hello {{1}} ji, your follow-up visit with {{2}} is due on {{3}}. Reply to book a time.", examples: ["Sunita", "Dr. Sharma", "17 Oct"], buttons: qr("Book now") },
    hi: { body: "नमस्ते {{1}} जी, {{2}} के साथ आपकी फ़ॉलो-अप विज़िट {{3}} को है। समय बुक करने के लिए जवाब दें।", examples: ["सुनीता", "डॉ. शर्मा", "17 अक्टू"], buttons: qr("अभी बुक करें") },
  },
  payment_due: {
    en: { body: "Hello {{1}} ji, a payment of ₹{{2}} is pending for your visit to {{3}} on {{4}}. You can pay at the clinic, or online using the button below.", examples: ["Ramesh", "500", "Dr. Sharma's Clinic", "20 Oct"], buttons: payBtn("Pay now") },
    hi: { body: "नमस्ते {{1}} जी, ₹{{2}} का भुगतान बाकी है: {{3}} में {{4}} की विज़िट। आप क्लिनिक पर या नीचे दिए बटन से ऑनलाइन भुगतान कर सकते हैं।", examples: ["रमेश", "500", "डॉ. शर्मा क्लिनिक", "20 अक्टू"], buttons: payBtn("अभी भुगतान करें") },
  },
  payment_received: {
    en: { body: "Thank you {{1}} ji. We have received your payment of ₹{{2}} for your visit on {{3}}. Nothing more is due for this visit.", examples: ["Ramesh", "500", "20 Oct"] },
    hi: { body: "धन्यवाद {{1}} जी। आपका ₹{{2}} का भुगतान मिल गया है ({{3}} की विज़िट)। इस विज़िट का अब कुछ बाकी नहीं है।", examples: ["रमेश", "500", "20 अक्टू"] },
  },
  staff_walkin_overflow: {
    en: { body: "Walk-in list is full for the {{1}} session. {{2}} ({{3}}) is at reception. Can you adjust?", examples: ["Evening", "Anil Verma", "+91 99887 xxxxx"], buttons: qr("Yes adjust", "No") },
    hi: { body: "आज के {{1}} सेशन की वॉक-इन सूची भर गई है। {{2}} ({{3}}) रिसेप्शन पर हैं। क्या एडजस्ट कर सकते हैं?", examples: ["शाम", "अनिल वर्मा", "+91 99887 xxxxx"], buttons: qr("हाँ", "नहीं") },
  },
  daily_summary: {
    en: { body: "Here is today's summary for {{1}}. Booked appointments: {{2}}. Walk-in patients: {{3}}. Consultations completed: {{4}}. Patients who did not come: {{5}}. Average waiting time: {{6}} minutes. Have a good evening.", examples: ["Dr. Sharma's Clinic", "18", "9", "25", "2", "14"] },
    hi: { body: "आज का सारांश, {{1}}। बुक किए गए अपॉइंटमेंट: {{2}}। वॉक-इन मरीज़: {{3}}। पूरी हुई कंसल्टेशन: {{4}}। जो मरीज़ नहीं आए: {{5}}। औसत इंतज़ार का समय: {{6}} मिनट। शुभ संध्या।", examples: ["डॉ. शर्मा क्लिनिक", "18", "9", "25", "2", "14"] },
  },
  no_show_rebook: {
    en: { body: "We missed you today, {{1}} ji. Reply to book another time.", examples: ["Ramesh"], buttons: qr("Book again") },
    hi: { body: "आज आप नहीं आ पाए, {{1}} जी। दूसरा समय बुक करने के लिए जवाब दें।", examples: ["रमेश"], buttons: qr("फिर से बुक करें") },
  },
};

/** Graph API `components` for submitting a template; `base` is the server's public address (for URL buttons). */
export function templateComponents(name: Exclude<TemplateName, "staff_login_otp">, lang: Lang, base: string): unknown[] {
  const t = TEMPLATE_TEXT[name][lang];
  const components: unknown[] = [{ type: "BODY", text: t.body, example: { body_text: [t.examples] } }];
  if (t.buttons?.length) components.push({ type: "BUTTONS", buttons: JSON.parse(JSON.stringify(t.buttons).replaceAll("{{BASE}}", base.replace(/\/$/, ""))) });
  return components;
}

export function templateNames(): TemplateName[] {
  return Object.keys(TEMPLATES) as TemplateName[];
}
