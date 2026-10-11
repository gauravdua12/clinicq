// Copy bank (docs/CONVERSATION_GUIDE.md §6). The ONLY source of patient-facing text.
// Each entry: en / hi / hinglish, each a string or an array of variants (picked by seed).

export type Lang = "en" | "hi" | "hinglish";
type V = string | string[];
interface Entry { en: V; hi: V; hinglish: V }

const DISCLAIMER: Entry = {
  en: "I'm the appointment assistant for {{clinicName}}. I can help you book, reschedule or check your turn in the queue. Medical advice is given by Doctor during your consultation.",
  hi: "मैं {{clinicName}} की अपॉइंटमेंट असिस्टेंट हूँ। मैं बुकिंग, री-शेड्यूल या कतार में आपकी बारी बताने में मदद कर सकती हूँ। डॉक्टर की सलाह कंसल्टेशन के दौरान ही दी जाती है।",
  hinglish: "Main {{clinicName}} ki appointment assistant hoon. Booking, reschedule ya queue mein aapki baari batane mein madad kar sakti hoon. Medical salah Doctor consultation ke dauran hi dete hain.",
};

export const COPY = {
  WELCOME_CONSENT: {
    en: `Hello! 👋 ${DISCLAIMER.en}\n\nBefore we start: we save only your name, number and appointment details to manage your visit. Privacy notice: {{noticeUrl}}`,
    hi: `नमस्ते! 👋 ${DISCLAIMER.hi}\n\nशुरू करने से पहले: आपकी विज़िट के लिए हम केवल नाम, नंबर और अपॉइंटमेंट की जानकारी रखते हैं। प्राइवेसी नोटिस: {{noticeUrl}}`,
    hinglish: `Namaste! 👋 ${DISCLAIMER.hinglish}\n\nShuru karne se pehle: hum sirf aapka naam, number aur appointment details rakhte hain. Privacy notice: {{noticeUrl}}`,
  },
  CONSENT_DECLINED: {
    en: "No problem. Without this I can't book online, but you're welcome to call the clinic at {{clinicPhone}} 📞.",
    hi: "कोई बात नहीं। इसके बिना मैं ऑनलाइन बुकिंग नहीं कर सकती, आप क्लिनिक को {{clinicPhone}} पर कॉल कर सकते हैं 📞।",
    hinglish: "Koi baat nahi. Iske bina main online booking nahi kar sakti, aap clinic ko {{clinicPhone}} par call kar sakte hain 📞.",
  },
  CONSENT_REMINDER: {
    en: "To book, please tap *I agree* on the message above, or reply \"agree\".",
    hi: "बुकिंग के लिए ऊपर वाले मैसेज पर *सहमत हूँ* दबाएँ, या \"agree\" लिखें।",
    hinglish: "Booking ke liye upar wale message par *Agree* dabayein, ya \"agree\" likhein.",
  },
  CONFIRM_NUMBER: {
    en: "Thank you{{nameJi}}. I'll book this with your number {{waPhone}}. Is that okay?",
    hi: "धन्यवाद{{nameJi}}। मैं यह बुकिंग आपके नंबर {{waPhone}} से करूँगी। ठीक है?",
    hinglish: "Thank you{{nameJi}}. Booking aapke number {{waPhone}} se kar doon?",
  },
  ASK_ALT_NUMBER: {
    en: "Sure, please type the 10-digit mobile number you'd like us to use.",
    hi: "ज़रूर, कृपया वह 10 अंकों का मोबाइल नंबर लिखें जो आप देना चाहते हैं।",
    hinglish: "Zaroor, please woh 10-digit mobile number likhiye jo aap dena chahte hain.",
  },
  ALT_NUMBER_INVALID: {
    en: "That doesn't look like a 10-digit mobile number. Could you check once?",
    hi: "यह 10 अंकों का मोबाइल नंबर नहीं लग रहा। एक बार देख लीजिए?",
    hinglish: "Yeh 10-digit mobile number nahi lag raha. Ek baar check kar lijiye?",
  },
  ALT_NUMBER_SAVED: {
    en: "Saved ✅ We'll use {{altPhone}} as the contact number. Updates will still come on this WhatsApp chat.",
    hi: "सेव हो गया ✅ संपर्क नंबर {{altPhone}} रहेगा। अपडेट इसी WhatsApp चैट पर आएँगे।",
    hinglish: "Save ho gaya ✅ Contact number {{altPhone}} rahega. Updates isi WhatsApp chat par aayenge.",
  },
  ASK_WHO: {
    en: "Is this appointment for you or someone else?",
    hi: "यह अपॉइंटमेंट आपके लिए है या किसी और के लिए?",
    hinglish: "Appointment aapke liye hai ya kisi aur ke liye?",
  },
  ASK_WHO_RETURNING: {
    en: "Welcome back, {{name}} ji. Is this for you or {{other}} ji?",
    hi: "फिर से स्वागत है, {{name}} जी। यह आपके लिए है या {{other}} जी के लिए?",
    hinglish: "Welcome back, {{name}} ji. Yeh aapke liye hai ya {{other}} ji ke liye?",
  },
  ASK_NAME_SELF: {
    en: "May I have your name, please?",
    hi: "कृपया अपना नाम बताइए।",
    hinglish: "Aapka naam bata dijiye please.",
  },
  ASK_NAME_OTHER: {
    en: "Sure. What's the patient's name? (You can also add the relation, like 'my mother Sunita')",
    hi: "ज़रूर। मरीज़ का नाम क्या है? (रिश्ता भी लिख सकते हैं, जैसे 'मेरी माँ सुनीता')",
    hinglish: "Zaroor. Patient ka naam kya hai? (Rishta bhi likh sakte hain, jaise 'meri mummy Sunita')",
  },
  ACK_PROFILE: {
    en: "Got it, booking for {{name}} ji.",
    hi: "ठीक है, {{name}} जी के लिए बुकिंग कर रही हूँ।",
    hinglish: "Theek hai, {{name}} ji ke liye booking kar rahi hoon.",
  },
  ASK_WHEN: {
    en: ["Which day and time suits you? You can type something like \"tomorrow evening\" or \"Monday 11 am\".", "When would you like to come in? Just tell me the day and roughly what time."],
    hi: ["आपको कौन सा दिन और समय ठीक रहेगा? जैसे \"कल शाम\" या \"सोमवार 11 बजे\" लिख सकते हैं।", "आप कब आना चाहेंगे? बस दिन और लगभग समय बता दीजिए।"],
    hinglish: ["Kaunsa din aur time theek rahega? Jaise \"kal shaam\" ya \"Monday 11 baje\" likh sakte hain.", "Aap kab aana chahenge? Bas din aur lagbhag time bata dijiye."],
  },
  OFFER_NEAR_TIME: {
    en: "For {{dayLabel}} ({{date}}) {{partOfDay}}, closest to {{requestedTime}}:",
    hi: "{{dayLabel}} ({{date}}) {{partOfDay}}, {{requestedTime}} के सबसे पास ये समय खाली हैं:",
    hinglish: "{{dayLabel}} ({{date}}) {{partOfDay}}, {{requestedTime}} ke sabse paas yeh time free hain:",
  },
  OFFER_EARLIEST: {
    en: "{{dayLabel}} ({{date}}) {{partOfDay}}, I have:",
    hi: "{{dayLabel}} ({{date}}) {{partOfDay}}, ये समय खाली हैं:",
    hinglish: "{{dayLabel}} ({{date}}) {{partOfDay}}, yeh time free hain:",
  },
  OFFER_NEXT_AVAILABLE: {
    en: "The next available times are:",
    hi: "अगले उपलब्ध समय ये हैं:",
    hinglish: "Agle available time yeh hain:",
  },
  NO_NEAR_SLOTS: {
    en: "{{dayLabel}} around {{requestedTime}} is fully booked, sorry. Please pick any free date and time here 👇",
    hi: "{{dayLabel}} {{requestedTime}} के आसपास सब बुक है, माफ़ कीजिए। यहाँ से कोई भी खाली दिन और समय चुन लीजिए 👇",
    hinglish: "{{dayLabel}} {{requestedTime}} ke aas paas sab slots bhar gaye hain. Yahan se koi bhi free din aur time chun lijiye 👇",
  },
  NO_SLOTS_DAY: {
    en: "{{dayLabel}} is fully booked, sorry. Please pick any free date and time here 👇",
    hi: "{{dayLabel}} पूरा बुक है, माफ़ कीजिए। यहाँ से कोई भी खाली दिन और समय चुन लीजिए 👇",
    hinglish: "{{dayLabel}} poora book hai. Yahan se koi bhi free din aur time chun lijiye 👇",
  },
  FLOW_BODY: {
    en: "Tap below to pick a date and time for {{name}} ji. You can also just type it, like \"tomorrow 6 pm\".",
    hi: "{{name}} जी के लिए नीचे टैप करके दिन और समय चुनें। चाहें तो लिख भी सकते हैं, जैसे \"कल शाम 6 बजे\"।",
    hinglish: "{{name}} ji ke liye neeche tap karke din aur time chuniye. Chahein to likh bhi sakte hain, jaise \"kal shaam 6 baje\".",
  },
  LIST_PICKER: {
    en: "Pick a time for {{name}} ji:",
    hi: "{{name}} जी के लिए समय चुनें:",
    hinglish: "{{name}} ji ke liye time chuniye:",
  },
  SLOT_TAKEN_TYPED: {
    en: "{{time}} is already booked, but these are close by:",
    hi: "{{time}} पहले से बुक है, पर ये समय पास में हैं:",
    hinglish: "{{time}} pehle se book hai, par yeh time paas mein hain:",
  },
  SLOT_HELD: {
    en: "Holding *{{dayShort}}, {{time}}* for {{name}} ji.",
    hi: "{{name}} जी के लिए *{{dayShort}}, {{time}}* रोक लिया है।",
    hinglish: "{{name}} ji ke liye *{{dayShort}}, {{time}}* hold kar liya hai.",
  },
  ASK_VISIT_TYPE: {
    en: "What is this visit for: a new consultation, a follow-up, or to get test reports reviewed by the doctor?",
    hi: "यह विज़िट किसलिए है: नई कंसल्टेशन, फ़ॉलो-अप, या डॉक्टर को टेस्ट रिपोर्ट दिखाने के लिए?",
    hinglish: "Yeh visit kis liye hai: nayi consultation, follow-up, ya doctor ko test report dikhane ke liye?",
  },
  BOOKING_CONFIRMED: {
    en: "Confirmed ✅\n\n*{{name}} ji*\n{{dayShort}}, {{time}} · {{visit}}\nToken *{{token}}*\n📍 {{clinicName}}, {{addressShort}}{{mapsLine}}\n\nI'll remind you a day before. Reply anytime to reschedule or cancel.",
    hi: "कन्फ़र्म ✅\n\n*{{name}} जी*\n{{dayShort}}, {{time}} · {{visit}}\nटोकन *{{token}}*\n📍 {{clinicName}}, {{addressShort}}{{mapsLine}}\n\nएक दिन पहले याद दिला दूँगी। री-शेड्यूल या कैंसल के लिए कभी भी मैसेज करें।",
    hinglish: "Ho gaya ✅\n\n*{{name}} ji*\n{{dayShort}}, {{time}} · {{visit}}\nToken *{{token}}*\n📍 {{clinicName}}, {{addressShort}}{{mapsLine}}\n\nEk din pehle yaad dila doongi. Reschedule ya cancel ke liye kabhi bhi message karein.",
  },
  HOLD_EXPIRED: {
    en: "I held {{time}} for a few minutes, but it's been released now. Shall I check times again?",
    hi: "मैंने {{time}} कुछ मिनट रोका था, अब वह छूट गया है। फिर से समय देखूँ?",
    hinglish: "Maine {{time}} kuch minute hold kiya tha, ab release ho gaya. Phir se time dekhoon?",
  },
  SLOT_RACE_LOST: {
    en: "Sorry {{name}} ji, {{time}} was taken just now. The nearest available times are:",
    hi: "माफ़ कीजिए {{name}} जी, {{time}} अभी-अभी बुक हो गया। सबसे पास के खाली समय:",
    hinglish: "Sorry {{name}} ji, {{time}} abhi abhi book ho gaya. Sabse paas ke free time:",
  },
  SLOT_RACE_DECLINED: {
    en: "I understand. Slots near {{requestedTime}} are full {{dayLabel}}. Would you like to try another day, or call the clinic? Staff will check if anything can be arranged.",
    hi: "समझ गई। {{dayLabel}} {{requestedTime}} के पास सब भरा है। क्या दूसरा दिन देखें, या क्लिनिक को कॉल करें? स्टाफ़ देख लेगा कि कुछ हो सकता है या नहीं।",
    hinglish: "Samajh gayi. {{dayLabel}} {{requestedTime}} ke paas sab full hai. Doosra din dekhein ya clinic ko call karein? Staff check kar lega.",
  },
  CALL_CLINIC: {
    en: "Please call {{clinicName}} at {{clinicPhone}} 📞 ({{sessionHours}}).",
    hi: "कृपया {{clinicName}} को {{clinicPhone}} पर कॉल करें 📞 ({{sessionHours}})।",
    hinglish: "Please {{clinicName}} ko {{clinicPhone}} par call karein 📞 ({{sessionHours}}).",
  },
  SAME_SLOT_FAMILY: {
    en: "{{time}} is booked for {{otherName}} ji, and each slot takes one patient. Shall I book {{name}} right after, at {{nextSlot}}?",
    hi: "{{time}} {{otherName}} जी के लिए बुक है, और हर स्लॉट में एक ही मरीज़ होता है। क्या {{name}} को ठीक बाद {{nextSlot}} पर बुक कर दूँ?",
    hinglish: "{{time}} {{otherName}} ji ke liye book hai, aur har slot mein ek hi patient hota hai. {{name}} ko theek baad {{nextSlot}} par book kar doon?",
  },
  RULE_CUTOFF: {
    en: "Online booking for {{time}} has closed (we need {{cutoff}} min notice).",
    hi: "{{time}} के लिए ऑनलाइन बुकिंग बंद हो गई है ({{cutoff}} मिनट पहले बुक करना होता है)।",
    hinglish: "{{time}} ke liye online booking band ho gayi hai ({{cutoff}} min pehle book karna hota hai).",
  },
  RULE_CLOSED: {
    en: "The clinic is closed on {{date}}.",
    hi: "{{date}} को क्लिनिक बंद है।",
    hinglish: "{{date}} ko clinic band hai.",
  },
  RULE_TOO_FAR: {
    en: "I can book up to {{windowDays}} days ahead. Please pick a date before {{maxDate}}.",
    hi: "मैं {{windowDays}} दिन आगे तक बुक कर सकती हूँ। कृपया {{maxDate}} से पहले की तारीख़ चुनें।",
    hinglish: "Main {{windowDays}} din aage tak book kar sakti hoon. Please {{maxDate}} se pehle ki date chuniye.",
  },
  RULE_PAST: {
    en: "That time has already passed.",
    hi: "वह समय निकल चुका है।",
    hinglish: "Woh time nikal chuka hai.",
  },
  RULE_PROFILE_LIMIT: {
    en: "{{name}} ji already has {{n}} upcoming appointments ({{list}}). Shall I reschedule one of those instead?",
    hi: "{{name}} जी के पहले से {{n}} अपॉइंटमेंट हैं ({{list}})। क्या उनमें से किसी को री-शेड्यूल करूँ?",
    hinglish: "{{name}} ji ke pehle se {{n}} appointments hain ({{list}}). Unmein se kisi ko reschedule karoon?",
  },
  RS_PICK_APPT: {
    en: "Which appointment would you like to change?",
    hi: "आप कौन सा अपॉइंटमेंट बदलना चाहते हैं?",
    hinglish: "Kaunsa appointment badalna hai?",
  },
  CX_PICK_APPT: {
    en: "Which appointment would you like to cancel?",
    hi: "आप कौन सा अपॉइंटमेंट कैंसल करना चाहते हैं?",
    hinglish: "Kaunsa appointment cancel karna hai?",
  },
  RS_ASK_WHEN: {
    en: "No problem. Which day and time would you prefer?",
    hi: "कोई बात नहीं। आपको कौन सा दिन और समय चाहिए?",
    hinglish: "Koi baat nahi. Kaunsa din aur time chahiye?",
  },
  RS_DONE: {
    en: "Moved ✅ {{name}} ji, {{dayShort}}, {{time}}, Token {{token}}. The {{oldTime}} slot is released.",
    hi: "बदल दिया ✅ {{name}} जी, {{dayShort}}, {{time}}, टोकन {{token}}। {{oldTime}} वाला स्लॉट छोड़ दिया गया है।",
    hinglish: "Shift ho gaya ✅ {{name}} ji, {{dayShort}}, {{time}}, Token {{token}}. {{oldTime}} wala slot release ho gaya.",
  },
  CX_CONFIRM: {
    en: "Cancel {{name}} ji's appointment on {{dayShort}} at {{time}}?",
    hi: "{{name}} जी का {{dayShort}} {{time}} का अपॉइंटमेंट कैंसल करूँ?",
    hinglish: "{{name}} ji ka {{dayShort}} {{time}} ka appointment cancel kar doon?",
  },
  CX_DONE: {
    en: "Cancelled. Hope to see you soon 🙏 Message me anytime to book again.",
    hi: "कैंसल हो गया। जल्द मिलेंगे 🙏 दोबारा बुक करने के लिए कभी भी मैसेज करें।",
    hinglish: "Cancel ho gaya. Jaldi milenge 🙏 Dobara book karne ke liye kabhi bhi message karein.",
  },
  CX_KEPT: {
    en: "Okay, your appointment stays as it is 😊",
    hi: "ठीक है, आपका अपॉइंटमेंट वैसा ही रहेगा 😊",
    hinglish: "Theek hai, aapka appointment waisa hi rahega 😊",
  },
  NO_UPCOMING: {
    en: "You don't have any upcoming appointments. Shall I find a time?",
    hi: "आपका कोई आने वाला अपॉइंटमेंट नहीं है। समय ढूँढूँ?",
    hinglish: "Aapka koi upcoming appointment nahi hai. Time dhoondhoon?",
  },
  MY_APPOINTMENTS: {
    en: "Your upcoming appointments:\n{{list}}",
    hi: "आपके आने वाले अपॉइंटमेंट:\n{{list}}",
    hinglish: "Aapke upcoming appointments:\n{{list}}",
  },
  REMINDER_CONFIRMED: {
    en: "Thank you, see you then 😊",
    hi: "धन्यवाद, मिलते हैं 😊",
    hinglish: "Thank you, milte hain 😊",
  },
  ARRIVED_OK: {
    en: "Welcome, {{name}} ji 🙏 You're checked in. Token {{token}}, {{ahead}} ahead of you (about {{eta}} min).",
    hi: "स्वागत है, {{name}} जी 🙏 आप चेक-इन हो गए हैं। टोकन {{token}}, आपसे पहले {{ahead}} (लगभग {{eta}} मिनट)।",
    hinglish: "Welcome, {{name}} ji 🙏 Aap check-in ho gaye hain. Token {{token}}, aapse pehle {{ahead}} (lagbhag {{eta}} min).",
  },
  ARRIVED_EARLY: {
    en: "You're a little early, {{name}} ji 😊 Your time is {{time}}. I'll add you to the queue at {{autoCheckIn}}. Please have a seat.",
    hi: "आप थोड़ा जल्दी आ गए, {{name}} जी 😊 आपका समय {{time}} है। {{autoCheckIn}} पर आपको कतार में जोड़ दूँगी। कृपया बैठिए।",
    hinglish: "Aap thoda jaldi aa gaye, {{name}} ji 😊 Aapka time {{time}} hai. {{autoCheckIn}} par queue mein add kar doongi. Please baithiye.",
  },
  ARRIVED_NO_BOOKING: {
    en: "I don't see a booking for today. To join today's walk-in queue, please scan the QR code at reception, or I can check booking times.",
    hi: "आज की कोई बुकिंग नहीं दिख रही। वॉक-इन कतार में जुड़ने के लिए रिसेप्शन पर QR कोड स्कैन करें, या मैं बुकिंग का समय देख सकती हूँ।",
    hinglish: "Aaj ki koi booking nahi dikh rahi. Walk-in queue ke liye reception par QR code scan karein, ya main booking time dekh sakti hoon.",
  },
  ALREADY_IN_QUEUE: {
    en: "You're already in today's queue, {{name}} ji: Token {{token}}, {{ahead}} ahead of you (about {{eta}} min).",
    hi: "आप पहले से आज की कतार में हैं, {{name}} जी: टोकन {{token}}, आपसे पहले {{ahead}} (लगभग {{eta}} मिनट)।",
    hinglish: "Aap pehle se aaj ki queue mein hain, {{name}} ji: Token {{token}}, aapse pehle {{ahead}} (lagbhag {{eta}} min).",
  },
  STATUS: {
    en: "Now with Doctor: {{current}}\nYou: {{token}}, {{ahead}} patients ahead\nEstimated wait: about {{eta}} min",
    hi: "अभी डॉक्टर के पास: {{current}}\nआपका टोकन: {{token}}, आपसे पहले {{ahead}} मरीज़\nअंदाज़न इंतज़ार: लगभग {{eta}} मिनट",
    hinglish: "Abhi Doctor ke saath: {{current}}\nAapka token: {{token}}, aapse pehle {{ahead}} patients\nAndazan wait: lagbhag {{eta}} min",
  },
  STATUS_NEXT: {
    en: "You're next, {{name}} ji. Please stay near the cabin.",
    hi: "अगला नंबर आपका है, {{name}} जी। कृपया केबिन के पास रहिए।",
    hinglish: "Agla number aapka hai, {{name}} ji. Cabin ke paas rahiye.",
  },
  STATUS_BOOKED: {
    en: "Your appointment is at {{time}} (Token {{token}}). Doctor is {{runningStatus}}. Please let me know when you reach: just say \"reached\".",
    hi: "आपका अपॉइंटमेंट {{time}} पर है (टोकन {{token}})। डॉक्टर {{runningStatus}}। पहुँचने पर बताइए: बस \"पहुँच गया\" लिखें।",
    hinglish: "Aapka appointment {{time}} par hai (Token {{token}}). Doctor {{runningStatus}}. Pahunch kar bataiye: bas \"reached\" likhiye.",
  },
  STATUS_NONE: {
    en: "Queue status is visible for your bookings only. You don't have a booking today. Shall I find a time?",
    hi: "कतार की स्थिति सिर्फ़ आपकी बुकिंग के लिए दिखती है। आज आपकी कोई बुकिंग नहीं है। समय ढूँढूँ?",
    hinglish: "Queue status sirf aapki booking ke liye dikhta hai. Aaj aapki koi booking nahi hai. Time dhoondhoon?",
  },
  STATUS_FUTURE: {
    en: "Queue status is visible for your bookings only, on the day of the visit. Your next booking: *{{name}} ji*, {{dayShort}}, {{time}} (Token *{{token}}*).",
    hi: "कतार की स्थिति सिर्फ़ आपकी बुकिंग के लिए, विज़िट वाले दिन दिखती है। आपकी अगली बुकिंग: *{{name}} जी*, {{dayShort}}, {{time}} (टोकन *{{token}}*)।",
    hinglish: "Queue status sirf aapki booking ke liye, visit wale din dikhta hai. Aapki agli booking: *{{name}} ji*, {{dayShort}}, {{time}} (Token *{{token}}*).",
  },
  ACK_CLOSING: {
    en: ["👍 Take care! Message me anytime you need.", "🙏 Take care. I'm here whenever you need me."],
    hi: ["👍 अपना ध्यान रखिए! ज़रूरत हो तो कभी भी मैसेज करें।", "🙏 ध्यान रखिए। जब भी ज़रूरत हो, मैं यहीं हूँ।"],
    hinglish: ["👍 Apna dhyaan rakhiye! Zaroorat ho to kabhi bhi message karein.", "🙏 Dhyaan rakhiye. Jab bhi zaroorat ho, main yahin hoon."],
  },
  LIST_PICK_SESSION: {
    en: "Which part of the day suits you on {{dayLabel}}? You can also type another day.",
    hi: "{{dayLabel}} को दिन का कौन सा समय ठीक रहेगा? चाहें तो कोई और दिन लिख दीजिए।",
    hinglish: "{{dayLabel}} ko din ka kaunsa time theek rahega? Chahein to koi aur din likh dijiye.",
  },
  RUNNING_ON_TIME: { en: "on time", hi: "समय पर हैं", hinglish: "time par hain" },
  RUNNING_LATE: { en: "running about {{min}} min late", hi: "लगभग {{min}} मिनट देरी से हैं", hinglish: "lagbhag {{min}} min late hain" },
  TURN_NEAR: {
    en: "{{name}} ji, your turn is coming up soon. {{ahead}} patients ahead of you (about {{eta}} min). Please stay near the reception.",
    hi: "{{name}} जी, आपकी बारी जल्द आने वाली है। आपसे पहले {{ahead}} मरीज़ (लगभग {{eta}} मिनट)। कृपया रिसेप्शन के पास रहिए।",
    hinglish: "{{name}} ji, aapki baari jaldi aane wali hai. Aapse pehle {{ahead}} patients (lagbhag {{eta}} min). Reception ke paas rahiye.",
  },
  YOU_ARE_NEXT: {
    en: "{{name}} ji, you're next. Please be ready to go into the cabin.",
    hi: "{{name}} जी, अगला नंबर आपका है। केबिन में जाने के लिए तैयार रहिए।",
    hinglish: "{{name}} ji, aap agle hain. Cabin mein jaane ke liye taiyaar rahiye.",
  },
  YOUR_TURN: {
    en: "It's your turn now 🙏 Please proceed to Doctor's cabin.",
    hi: "अब आपकी बारी है 🙏 कृपया डॉक्टर के केबिन में आइए।",
    hinglish: "Ab aapki baari hai 🙏 Doctor ke cabin mein aaiye.",
  },
  DOCTOR_LATE: {
    en: "Update: Doctor is running about {{min}} minutes behind. Your new estimated time is around {{newTime}}. Thank you for your patience 🙏",
    hi: "अपडेट: डॉक्टर लगभग {{min}} मिनट देरी से चल रहे हैं। आपका नया अंदाज़न समय {{newTime}} के आसपास है। धैर्य के लिए धन्यवाद 🙏",
    hinglish: "Update: Doctor lagbhag {{min}} minute late chal rahe hain. Aapka naya andazan time {{newTime}} ke aas paas hai. Dhanyavaad 🙏",
  },
  DOCTOR_BREAK: {
    en: "Doctor is on a short break and will resume in about {{min}} minutes. Your place in the queue is safe.",
    hi: "डॉक्टर छोटे ब्रेक पर हैं और लगभग {{min}} मिनट में लौटेंगे। कतार में आपकी जगह सुरक्षित है।",
    hinglish: "Doctor chhote break par hain, lagbhag {{min}} minute mein wapas aayenge. Queue mein aapki jagah safe hai.",
  },
  NO_SHOW_CALLED: {
    en: "We called token {{token}} but couldn't find you. Message \"reached\" when you're back and I'll add you to the queue again.",
    hi: "हमने टोकन {{token}} बुलाया पर आप नहीं मिले। वापस आने पर \"पहुँच गया\" लिखें, मैं आपको फिर से कतार में जोड़ दूँगी।",
    hinglish: "Humne token {{token}} bulaya par aap nahi mile. Wapas aakar \"reached\" likhiye, main phir se queue mein add kar doongi.",
  },
  NO_SHOW_MISSED: {
    en: "We missed you today, {{name}} ji. Would you like to book another time?",
    hi: "आज आप नहीं आ पाए, {{name}} जी। क्या दूसरा समय बुक करें?",
    hinglish: "Aaj aap nahi aa paaye, {{name}} ji. Doosra time book karein?",
  },
  WALKIN_ASK_NAME: {
    en: "Welcome to {{clinicName}} 🙏 I'll register you with {{waPhone}}. May I have the patient's name?",
    hi: "{{clinicName}} में स्वागत है 🙏 मैं आपको {{waPhone}} से रजिस्टर करूँगी। मरीज़ का नाम बताइए?",
    hinglish: "{{clinicName}} mein swagat hai 🙏 Main aapko {{waPhone}} se register karoongi. Patient ka naam bataiye?",
  },
  WALKIN_TOKEN: {
    en: "Thank you, {{name}} ji. Your token is *{{token}}*. {{ahead}} patients ahead of you, about {{eta}} min. I'll message you when your turn is near, so feel free to sit comfortably.",
    hi: "धन्यवाद, {{name}} जी। आपका टोकन *{{token}}* है। आपसे पहले {{ahead}} मरीज़, लगभग {{eta}} मिनट। बारी पास आने पर मैं मैसेज करूँगी, आराम से बैठिए।",
    hinglish: "Thank you, {{name}} ji. Aapka token *{{token}}* hai. Aapse pehle {{ahead}} patients, lagbhag {{eta}} min. Baari paas aane par message karoongi, aaram se baithiye.",
  },
  WALKIN_CHECKING: {
    en: "Thanks, {{name}} ji. Today's walk-in slots are full, so let me check with the reception team. One moment please 🙏",
    hi: "धन्यवाद, {{name}} जी। आज के वॉक-इन स्लॉट भर गए हैं, मैं रिसेप्शन से पूछ रही हूँ। एक पल रुकिए 🙏",
    hinglish: "Thanks, {{name}} ji. Aaj ke walk-in slots full hain, main reception se pooch rahi hoon. Ek minute please 🙏",
  },
  WALKIN_ADJUSTED: {
    en: "Good news, {{name}} ji. The clinic has made space for you.\n\nToken *{{token}}*, around {{time}}\n{{ahead}} patients ahead of you.\n\nI'll message you when your turn is near.",
    hi: "अच्छी खबर, {{name}} जी। क्लिनिक ने आपके लिए जगह बना दी है।\n\nटोकन *{{token}}*, लगभग {{time}}\nआपसे पहले {{ahead}} मरीज़।\n\nबारी पास आने पर मैसेज करूँगी।",
    hinglish: "Achhi khabar, {{name}} ji. Clinic ne aapke liye jagah bana di hai.\n\nToken *{{token}}*, lagbhag {{time}}\nAapse pehle {{ahead}} patients.\n\nBaari paas aane par message karoongi.",
  },
  WALKIN_DECLINED: {
    en: "Sorry {{name}} ji, today's walk-in list is full. The next available appointments are:",
    hi: "माफ़ कीजिए {{name}} जी, आज की वॉक-इन सूची भर गई है। अगले उपलब्ध अपॉइंटमेंट:",
    hinglish: "Sorry {{name}} ji, aaj ki walk-in list full hai. Agle available appointments:",
  },
  WALKIN_TIMEOUT: {
    en: "Reception is busy right now, sorry for the wait. Here are the next available appointment times:",
    hi: "रिसेप्शन अभी व्यस्त है, इंतज़ार के लिए माफ़ी। अगले उपलब्ध अपॉइंटमेंट समय:",
    hinglish: "Reception abhi busy hai, wait ke liye sorry. Agle available appointment time:",
  },
  STALE_MESSAGE: {
    en: "Sorry, we couldn't reply to your earlier message 🙏 Please send your request again and I'll help right away.",
    hi: "माफ़ कीजिए, हम आपके पिछले संदेश का जवाब नहीं दे पाए 🙏 कृपया अपना अनुरोध दोबारा भेजें, मैं तुरंत मदद करूँगा।",
    hinglish: "Sorry, aapke pichhle message ka reply nahi de paaye 🙏 Please apni request dobara bhejein, main turant help karunga.",
  },
  STAFF_OTP_TEXT: {
    en: "{{code}} is your ClinicQ login code. It expires in 5 minutes. Don't share it with anyone.",
    hi: "{{code}} आपका ClinicQ लॉगिन कोड है। यह 5 मिनट में समाप्त हो जाएगा। इसे किसी से साझा न करें।",
    hinglish: "{{code}} aapka ClinicQ login code hai. 5 minute mein expire hoga. Kisi ke saath share na karein.",
  },
  WALKIN_BAD_CODE: {
    en: "Please scan the QR code at the reception desk to join today's queue 😊 If you'd like to book for another day, just tell me when.",
    hi: "आज की कतार में जुड़ने के लिए रिसेप्शन पर लगा QR कोड स्कैन करें 😊 किसी और दिन के लिए बुक करना हो तो बस बताइए।",
    hinglish: "Aaj ki queue mein judne ke liye reception par QR code scan karein 😊 Kisi aur din ke liye booking chahiye to bas bataiye.",
  },
  WALKIN_CLOSED: {
    en: "The clinic isn't running a session right now. Next session: {{next}}. Shall I book a time?",
    hi: "अभी क्लिनिक का सेशन नहीं चल रहा। अगला सेशन: {{next}}। समय बुक करूँ?",
    hinglish: "Abhi clinic ka session nahi chal raha. Agla session: {{next}}. Time book karoon?",
  },
  OR_CALL_CLINIC: {
    en: "Or call the clinic: {{clinicPhone}} 📞",
    hi: "या क्लिनिक को कॉल करें: {{clinicPhone}} 📞",
    hinglish: "Ya clinic ko call karein: {{clinicPhone}} 📞",
  },
  HEALTH_DETAILS_REDIRECT: {
    en: ["Thank you for sharing{{nameJi}} 🙏 Please keep health details for your consultation. Doctor will go through everything with you in person.", "I hope you feel better soon 🙏 Doctor will go through everything with you in person. I can help with the timing."],
    hi: ["बताने के लिए धन्यवाद{{nameJi}} 🙏 सेहत से जुड़ी बातें कंसल्टेशन के लिए रखिए। डॉक्टर आपसे मिलकर सब देखेंगे।", "आप जल्दी ठीक हो जाएँ 🙏 डॉक्टर आपसे मिलकर सब देखेंगे। मैं समय तय करने में मदद करती हूँ।"],
    hinglish: ["Batane ke liye shukriya{{nameJi}} 🙏 Health ki baatein consultation ke liye rakhiye. Doctor milkar sab detail mein dekhenge.", "Aap jaldi theek ho jaayein 🙏 Health ki baatein Doctor consultation mein detail mein dekhenge. Main time fix karne mein madad karti hoon."],
  },
  HEALTH_NOT_SAVED: {
    en: "Any health concerns are best discussed with Doctor during your visit, so I haven't saved those.",
    hi: "सेहत से जुड़ी बातें डॉक्टर से विज़िट में करना ही बेहतर है, इसलिए मैंने वे सेव नहीं कीं।",
    hinglish: "Health ki baatein Doctor se visit mein karna hi behtar hai, isliye maine woh save nahi ki.",
  },
  MEDIA_REPORTS: {
    en: "Please bring your reports with you to the clinic. Doctor will review them during the consultation 😊",
    hi: "कृपया अपनी रिपोर्ट क्लिनिक साथ लेकर आइए। डॉक्टर कंसल्टेशन में उन्हें देखेंगे 😊",
    hinglish: "Please apni reports clinic saath lekar aaiye. Doctor consultation mein dekhenge 😊",
  },
  VOICE_UNDERSTOOD: {
    en: "Thank you{{nameJi}}. I understood you'd like an appointment {{when}}.",
    hi: "धन्यवाद{{nameJi}}। मैं समझ गई, आपको {{when}} अपॉइंटमेंट चाहिए।",
    hinglish: "Thank you{{nameJi}}. Samajh gayi, aapko {{when}} appointment chahiye.",
  },
  VOICE_UNCLEAR: {
    en: "Sorry, I couldn't catch that clearly. Could you type the day and time you'd like?",
    hi: "माफ़ कीजिए, मैं ठीक से समझ नहीं पाई। क्या आप दिन और समय लिखकर बता सकते हैं?",
    hinglish: "Sorry, theek se samajh nahi paayi. Din aur time likh kar bata denge?",
  },
  VOICE_TOO_LONG: {
    en: "That's a long voice note 😊 Could you tell me just the day and time you'd like to come?",
    hi: "यह लंबा वॉइस नोट है 😊 बस दिन और समय बता दीजिए जब आप आना चाहते हैं।",
    hinglish: "Yeh lamba voice note hai 😊 Bas din aur time bata dijiye kab aana hai.",
  },
  MAIN_MENU: {
    en: "Hello{{nameJi}} 😊 How can I help today?",
    hi: "नमस्ते{{nameJi}} 😊 आज मैं कैसे मदद करूँ?",
    hinglish: "Namaste{{nameJi}} 😊 Aaj kaise madad karoon?",
  },
  OTHER_HELP: {
    en: "I can help you book, reschedule, cancel or check your turn in the queue. What would you like to do?",
    hi: "मैं बुकिंग, री-शेड्यूल, कैंसल या कतार में आपकी बारी बताने में मदद कर सकती हूँ। आप क्या करना चाहेंगे?",
    hinglish: "Main booking, reschedule, cancel ya queue mein baari batane mein madad kar sakti hoon. Kya karna hai?",
  },
  CLINIC_TIMINGS: {
    en: "{{clinicName}} timings: {{sessionsText}}.",
    hi: "{{clinicName}} का समय: {{sessionsText}}।",
    hinglish: "{{clinicName}} ki timings: {{sessionsText}}.",
  },
  CLINIC_ADDRESS: {
    en: "📍 {{clinicName}}, {{address}}{{mapsLine}}",
    hi: "📍 {{clinicName}}, {{address}}{{mapsLine}}",
    hinglish: "📍 {{clinicName}}, {{address}}{{mapsLine}}",
  },
  CLINIC_FEES: {
    en: "Consultation fee: {{fees}}. For anything else about fees, please call {{clinicPhone}}.",
    hi: "कंसल्टेशन फ़ीस: {{fees}}। फ़ीस से जुड़ी और जानकारी के लिए {{clinicPhone}} पर कॉल करें।",
    hinglish: "Consultation fee: {{fees}}. Fees ke baare mein aur jaankari ke liye {{clinicPhone}} par call karein.",
  },
  TALK_TO_STAFF: {
    en: "Sure. You can call the clinic at {{clinicPhone}} 📞 ({{sessionHours}}). I've also let the reception know you'd like a call back.",
    hi: "ज़रूर। आप क्लिनिक को {{clinicPhone}} पर कॉल कर सकते हैं 📞 ({{sessionHours}})। मैंने रिसेप्शन को भी बता दिया है कि आपको कॉल बैक चाहिए।",
    hinglish: "Zaroor. Aap clinic ko {{clinicPhone}} par call kar sakte hain 📞 ({{sessionHours}}). Maine reception ko bhi bata diya hai ki aapko call back chahiye.",
  },
  THANKS_REPLY: {
    en: ["You're welcome 🙏 Take care.", "Happy to help 😊 Take care."],
    hi: ["आपका स्वागत है 🙏 अपना ध्यान रखिए।", "मदद करके ख़ुशी हुई 😊 ध्यान रखिए।"],
    hinglish: ["Aapka swagat hai 🙏 Apna dhyaan rakhiye.", "Madad karke khushi hui 😊 Dhyaan rakhiye."],
  },
  RESUME_PROMPT: {
    en: "Coming back to your booking: {{pending}}",
    hi: "आपकी बुकिंग पर लौटते हैं: {{pending}}",
    hinglish: "Aapki booking par wapas aate hain: {{pending}}",
  },
  RATE_LIMITED: {
    en: "I'm receiving a lot of messages at once. Please give me a moment 🙏",
    hi: "एक साथ बहुत सारे मैसेज आ रहे हैं। कृपया थोड़ा रुकिए 🙏",
    hinglish: "Ek saath bahut messages aa rahe hain. Thoda ruk jaiye please 🙏",
  },
  SYSTEM_ERROR: {
    en: "Sorry, something went wrong on my side. Please try again in a minute, or call {{clinicPhone}}.",
    hi: "माफ़ कीजिए, मेरी तरफ़ से कुछ गड़बड़ हुई। एक मिनट बाद फिर कोशिश करें, या {{clinicPhone}} पर कॉल करें।",
    hinglish: "Sorry, meri taraf se kuch gadbad hui. Ek minute baad try karein, ya {{clinicPhone}} par call karein.",
  },
  EMERGENCY_REPLY: {
    en: "If this is an emergency, please call *108* or go to the nearest hospital right away.\nYou can also call the clinic directly: {{clinicPhone}}",
    hi: "अगर यह आपातकाल है, तो तुरंत *108* पर कॉल करें या नज़दीकी अस्पताल जाएँ।\nआप क्लिनिक को सीधे भी कॉल कर सकते हैं: {{clinicPhone}}",
    hinglish: "Agar yeh emergency hai, to turant *108* par call karein ya nazdeeki hospital jaayein.\nAap clinic ko seedhe bhi call kar sakte hain: {{clinicPhone}}",
  },
  CANCELLED_BY_CLINIC: {
    en: "Sorry {{name}} ji, Doctor is unavailable on {{date}}. Your {{time}} appointment is cancelled. Please pick a new time or call {{clinicPhone}}.",
    hi: "माफ़ कीजिए {{name}} जी, {{date}} को डॉक्टर उपलब्ध नहीं हैं। आपका {{time}} का अपॉइंटमेंट कैंसल हो गया है। नया समय चुनें या {{clinicPhone}} पर कॉल करें।",
    hinglish: "Sorry {{name}} ji, {{date}} ko Doctor available nahi hain. Aapka {{time}} ka appointment cancel ho gaya hai. Naya time chuniye ya {{clinicPhone}} par call karein.",
  },
  REMINDER_24H: {
    en: "Reminder: {{name}} ji, your appointment with {{doctor}} is tomorrow, {{dayShort}} at {{time}} (Token {{token}}).",
    hi: "याद दिला रही हूँ: {{name}} जी, {{doctor}} के साथ आपका अपॉइंटमेंट कल, {{dayShort}} {{time}} पर है (टोकन {{token}})।",
    hinglish: "Reminder: {{name}} ji, {{doctor}} ke saath aapka appointment kal, {{dayShort}} {{time}} par hai (Token {{token}}).",
  },
  REMINDER_SAME_DAY: {
    en: "Today at {{time}}: {{name}} ji's appointment (Token {{token}}). Doctor is {{runningStatus}}. 📍 {{addressShort}}{{mapsLine}}",
    hi: "आज {{time}} पर: {{name}} जी का अपॉइंटमेंट (टोकन {{token}})। डॉक्टर {{runningStatus}}। 📍 {{addressShort}}{{mapsLine}}",
    hinglish: "Aaj {{time}} par: {{name}} ji ka appointment (Token {{token}}). Doctor {{runningStatus}}. 📍 {{addressShort}}{{mapsLine}}",
  },
  MY_DATA: {
    en: "Here's what we keep for this number:\n{{summary}}\n\nWe don't store any health information. To delete everything, reply \"delete my data\".",
    hi: "इस नंबर के लिए हमारे पास यह जानकारी है:\n{{summary}}\n\nहम कोई स्वास्थ्य जानकारी नहीं रखते। सब हटाने के लिए \"delete my data\" लिखें।",
    hinglish: "Is number ke liye humare paas yeh jaankari hai:\n{{summary}}\n\nHum koi health information nahi rakhte. Sab hatane ke liye \"delete my data\" likhiye.",
  },
  ERASE_CONFIRM: {
    en: "This will cancel your upcoming appointments and delete your details from {{clinicName}}. Continue?",
    hi: "इससे आपके आने वाले अपॉइंटमेंट कैंसल होंगे और {{clinicName}} से आपकी जानकारी हट जाएगी। आगे बढ़ें?",
    hinglish: "Isse aapke upcoming appointments cancel honge aur {{clinicName}} se aapki details hat jaayengi. Aage badhein?",
  },
  ERASE_DONE: {
    en: "Done. Your details have been deleted. You're welcome to message us anytime in future 🙏",
    hi: "हो गया। आपकी जानकारी हटा दी गई है। भविष्य में कभी भी मैसेज करें 🙏",
    hinglish: "Ho gaya. Aapki details delete ho gayi hain. Future mein kabhi bhi message karein 🙏",
  },
  OPTED_OUT: {
    en: "Okay, I won't send you reminders or updates anymore. You can still message me anytime; reply \"start\" to turn updates back on.",
    hi: "ठीक है, अब मैं आपको रिमाइंडर या अपडेट नहीं भेजूँगी। आप कभी भी मैसेज कर सकते हैं; अपडेट फिर चालू करने के लिए \"start\" लिखें।",
    hinglish: "Theek hai, ab main reminders ya updates nahi bhejoongi. Aap kabhi bhi message kar sakte hain; updates wapas chalu karne ke liye \"start\" likhiye.",
  },
  OPTED_IN: {
    en: "Updates are back on ✅",
    hi: "अपडेट फिर से चालू ✅",
    hinglish: "Updates wapas chalu ✅",
  },
  LANGUAGE_SET: {
    en: "Sure, I'll continue in English.",
    hi: "ठीक है, अब मैं हिंदी में बात करूँगी।",
    hinglish: "Theek hai, ab Hinglish mein baat karte hain.",
  },
  CHANGE_NUMBER_INFO: {
    en: "Your WhatsApp number stays the same, but I can save a different contact number. Please type the 10-digit mobile number.",
    hi: "आपका WhatsApp नंबर वही रहेगा, पर मैं दूसरा संपर्क नंबर सेव कर सकती हूँ। कृपया 10 अंकों का मोबाइल नंबर लिखें।",
    hinglish: "Aapka WhatsApp number wahi rahega, par main doosra contact number save kar sakti hoon. 10-digit mobile number likhiye.",
  },
  EXTRACTOR_DOWN: {
    en: "You can tap an option below.",
    hi: "नीचे दिए विकल्प पर टैप करें।",
    hinglish: "Neeche diye option par tap karein.",
  },
} satisfies Record<string, Entry>;

export type CopyId = keyof typeof COPY;

// Button labels — WhatsApp limit: 20 characters (validated in tests).
export const BTN = {
  AGREE: { en: "I agree, continue", hi: "सहमत हूँ, आगे बढ़ें", hinglish: "Agree, aage badhein" },
  USE_NUMBER: { en: "Use {{phone}}", hi: "यही नंबर", hinglish: "Haan, yahi number" },
  DIFFERENT_NUMBER: { en: "Different number", hi: "दूसरा नंबर", hinglish: "Doosra number" },
  FOR_ME: { en: "For me", hi: "मेरे लिए", hinglish: "Mere liye" },
  SOMEONE_ELSE: { en: "Someone else", hi: "किसी और के लिए", hinglish: "Kisi aur ke liye" },
  SEE_ALL: { en: "See all slots", hi: "सभी स्लॉट देखें", hinglish: "Saare slots dekhein" },
  NEW: { en: "New consultation", hi: "नई कंसल्टेशन", hinglish: "Nayi consultation" },
  FOLLOW_UP: { en: "Follow-up", hi: "फ़ॉलो-अप", hinglish: "Follow-up" },
  REPORT_SHOW: { en: "Report review", hi: "रिपोर्ट दिखाने", hinglish: "Report dikhane" },
  RESCHEDULE: { en: "Reschedule", hi: "री-शेड्यूल", hinglish: "Reschedule" },
  CANCEL: { en: "Cancel", hi: "कैंसल", hinglish: "Cancel" },
  CONFIRM: { en: "Confirm", hi: "कन्फ़र्म", hinglish: "Confirm" },
  YES_CANCEL: { en: "Yes, cancel", hi: "हाँ, कैंसल करें", hinglish: "Haan, cancel karo" },
  KEEP_IT: { en: "Keep it", hi: "रहने दें", hinglish: "Rehne do" },
  TRY_ANOTHER_DAY: { en: "Try another day", hi: "दूसरा दिन", hinglish: "Doosra din" },
  CALL_CLINIC: { en: "Call clinic", hi: "क्लिनिक कॉल करें", hinglish: "Clinic call karein" },
  CHECK_TIMES: { en: "Check times", hi: "समय देखें", hinglish: "Time dekhein" },
  CHECK_STATUS: { en: "Check my status", hi: "मेरी बारी देखें", hinglish: "Meri baari dekhein" },
  BOOK: { en: "Book appointment", hi: "अपॉइंटमेंट बुक करें", hinglish: "Appointment book" },
  MY_APPTS: { en: "My appointments", hi: "मेरे अपॉइंटमेंट", hinglish: "Mere appointments" },
  QUEUE_STATUS: { en: "Queue status", hi: "कतार की स्थिति", hinglish: "Queue status" },
  BOOK_AGAIN: { en: "Book again", hi: "फिर से बुक करें", hinglish: "Phir se book karein" },
  BOOK_SLOT: { en: "Book {{time}}", hi: "{{time}} बुक करें", hinglish: "{{time}} book karein" },
  PICK_NEW_TIME: { en: "Pick new time", hi: "नया समय चुनें", hinglish: "Naya time chunein" },
  YES_DELETE: { en: "Yes, delete", hi: "हाँ, हटा दें", hinglish: "Haan, delete karo" },
  CHOOSE_DATE_TIME: { en: "Choose date & time", hi: "दिन और समय चुनें", hinglish: "Din aur time chunein" },
  VIEW_SLOTS: { en: "View slots", hi: "स्लॉट देखें", hinglish: "Slots dekhein" },
  // staff
  YES_ADJUST: { en: "Yes, adjust", hi: "हाँ, एडजस्ट करें", hinglish: "Haan, adjust karo" },
  NO: { en: "No", hi: "नहीं", hinglish: "Nahi" },
  END_OF_QUEUE: { en: "End of queue", hi: "कतार के अंत में", hinglish: "Queue ke end mein" },
} satisfies Record<string, Entry>;
export type BtnId = keyof typeof BTN;

export type Vars = Record<string, string | number | null | undefined>;

function fill(t: string, vars: Vars): string {
  return t.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = vars[k];
    return v == null ? "" : String(v);
  });
}

function pick(v: V, seed: number): string {
  return Array.isArray(v) ? v[Math.abs(seed) % v.length]! : v;
}

export function render(id: CopyId, lang: Lang, vars: Vars = {}, seed = 0): string {
  const e = COPY[id] as Entry;
  return fill(pick(e[lang] ?? e.en, seed), vars).replace(/[ \t]+\n/g, "\n").trim();
}

export function btn(id: BtnId, lang: Lang, vars: Vars = {}): string {
  const e = BTN[id] as Entry;
  return fill(pick(e[lang] ?? e.en, 0), vars).slice(0, 20);
}

export function variantsOf(id: CopyId | BtnId): Entry {
  return ((COPY as Record<string, Entry>)[id] ?? (BTN as Record<string, Entry>)[id])!;
}
