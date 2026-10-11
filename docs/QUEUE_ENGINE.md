# Slot engine and token queue engine

All functions live in `packages/core` and are pure (inputs: settings, data, `now`). Worked examples in §6 are test cases.

## 1. Definitions
- **Session:** a recurring weekly window for the doctor, e.g. `{weekday: SAT, start: "17:00", end: "20:00", slotMinutes: 20, walkinQuota: 10, label: "Evening"}`.
- **Session instance:** a session on a specific date (`2026-10-11 Evening`). Tokens and quotas are counted per instance.
- **Slot:** `[start, start+slotMinutes)` inside a session instance. Identified by `slotKey = "<doctorId>:<ISO start UTC>"`.
- **Part of day mapping:** morning < 12:00 ≤ afternoon < 16:00 ≤ evening < 20:00 ≤ night. A request for "evening" maps to the session(s) overlapping that range.

## 2. Slot engine
### 2.1 `generateSlots(sessionInstance)`
Slots run from start in steps of `slotMinutes`. A trailing partial slot is dropped.

### 2.2 `isBookable(slot, now, settings, closures, appointments)`
All of the following must hold: slot.start ≥ now + cutoffMinutes; slot.date ≤ today + windowDays; not in a closure; not blocked by staff; no active appointment with the same `slotKey` (statuses `HELD` (unexpired), `BOOKED`, `ARRIVED`).

### 2.3 `findNearSlots(request, freeSlots, settings)` (smart suggest, form E)
Input `request = {date, time?, partOfDay?}`.
1. `candidates` = free bookable slots on `request.date`.
2. If `time` is given: keep candidates with `|slot.start - time| ≤ nearWindowMinutes` (default 60). Sort by distance, and break ties with the **earlier** slot. Take 2.
3. Else if `partOfDay` is given: candidates inside matching sessions, earliest 2.
4. Else (date only): the earliest 2 candidates of the day.
5. Return `{near: Slot[0..2], hasAny: candidates.length>0}`.
**Bot decision:** `near.length ≥ 1` → form E (buttons: near slots + "See all slots"). `near.length = 0` → form D (Flow), with the Flow opened on `request.date` if `hasAny`, else on the next date with free slots.
Display slots in the near pair in **chronological order** (e.g., 5:50 then 6:10), even when 6:10 is closer.

### 2.4 Holds
- `hold(slotKey, profileId, ttl=5min)` inserts an Appointment with status `HELD`, `holdExpiresAt`, `slotKey` set. The insert fails on a unique violation, which means the slot was taken (race lost).
- Before inserting, delete any `HELD` row with the same slotKey whose `holdExpiresAt < now` (same transaction).
- `confirm(appointmentId)` sets HELD → BOOKED and allocates the token. If the hold expired and the slot is still free, re-acquire it; otherwise race lost.
- `holdSweep` (1 min) deletes expired holds.
- With the payment toggle on, the hold TTL is `paymentHoldMinutes`.

### 2.5 One booking per slot
`Appointment.slotKey` is `UNIQUE` and nullable. It is set for HELD/BOOKED/ARRIVED and set to NULL when the appointment becomes CANCELLED, NO_SHOW or COMPLETED. This frees the key and keeps the history. The rule applies across all profiles and accounts, including family members on the same phone.
*Note: a COMPLETED appointment releasing its key is harmless, because past slots aren't bookable.*

## 3. Tokens
### 3.1 Series
- Default `A-` (appointments) and `W-` (walk-ins), per session instance, starting at 1. Setting `singleSeries=true` uses plain numbers for both (`1, 2, 3…`).
- Counter: the `TokenCounter(doctorId, date, sessionId, series)` row is incremented with `UPDATE … SET value = value + 1 RETURNING value` inside the allocating transaction (upsert on first use). No gaps are reused.

### 3.2 Appointment token assignment
Appointment tokens follow **slot order** so the token reflects position: at confirmation, `token = A-(index of slot among the session's slots + 1)`. This means a booking for the 6:10 slot of an evening session that starts 17:00 with 20-min slots gets **A-4**, not "the 9th booking".
> The approved mockups (docs/mockups/booking-ui.html) use this rule: the 6:10 slot gets A-4. The slot-index rule is the default, and setting `appointmentTokenMode = "slotIndex" | "sequential"` lets the clinic choose. `sequential` uses the counter.

### 3.3 Walk-in token
`W-n` comes from the counter at issue time (WI-02, WI-03 Yes, staff ADD).

## 4. Queue engine
### 4.1 States and transitions
Visible states: **WAITING → NEXT → IN_CONSULT**. Terminal states: **COMPLETED, NO_SHOW, CANCELLED**.
| From | Event | To | Side effects |
|---|---|---|---|
| (none) | arrive (appointment check-in / walk-in issued / staff add / re-add) | WAITING | position computed |
| WAITING | promote (auto or "move to next") | NEXT | notify YOU_ARE_NEXT |
| NEXT | start | IN_CONSULT | notify YOUR_TURN; record `consultStartedAt` |
| IN_CONSULT | complete | COMPLETED | record `completedAt`; consult duration → ETA stats; appointment → COMPLETED |
| NEXT | no-show | NO_SHOW | notify NO_SHOW_CALLED; promote next |
| WAITING/NEXT | cancel | CANCELLED | promote if NEXT |
| NO_SHOW | re-add ("reached" / staff) | WAITING (end of queue) | |
| IN_CONSULT | undo (within 2 min, staff) | NEXT | audit |
**Invariants per session instance:** at most one NEXT and at most one IN_CONSULT.

### 4.2 Composite action "Consultation completed" (`advance()`)
```
tx:
  if IN_CONSULT exists → complete it
  if NEXT exists       → start it (NEXT → IN_CONSULT)
  n = pickNext(WAITING) → promote n to NEXT (if any)
emit queue.updated; notifications; recompute ETAs
```
If IN_CONSULT is empty and NEXT exists, the board button becomes **Start consultation** (`start()` only).
Auto-promote: any time NEXT is empty and WAITING isn't, promote `pickNext()`.

### 4.3 `pickNext(waiting, now, settings)`: ordering rule
Each WAITING entry has: `source (A|W)`, `slotStart?` (A), `expectedAt?` (W with a staff-assigned time), `arrivedAt`, `manualRank?` (move up or down), `lateArrival: boolean` (A that arrived after slotStart + lateGrace).
1. **Manual overrides first:** if staff moved someone (`manualRank`), respect the resulting order.
2. **Due appointments:** A entries with `!lateArrival` and `slotStart ≤ now + 5 min` (due or about due). Earliest `slotStart` first.
3. **Fairness guard:** if the last `maxConsecutiveWalkins` (default 2) promoted entries were all W and any A is waiting (even if not yet due), pick the earliest A.
4. **Walk-ins and the rest:** W entries by `expectedAt ?? arrivedAt`, non-due A entries by `slotStart`, and late arrivals by `arrivedAt` (they join the end), merged by their effective time `effTime = A: slotStart | W: expectedAt ?? arrivedAt | late A: arrivedAt`. Earliest `effTime` first.
5. Tiebreak: A before W, then lower token number.

`positions()` returns the Waiting list in the same order the repeated `pickNext` would produce. This is the order shown on the board, the TV and in STATUS replies.

### 4.4 ETA
- `avgConsult` = mean duration of today's last 10 COMPLETED consults in this session instance. If fewer than 3 consults exist, use `slotMinutes`.
- `remainingCurrent` = max(0, avgConsult − elapsed of IN_CONSULT).
- For a waiting entry at position `k` (0-based within Waiting, after NEXT): `eta = remainingCurrent + (NEXT ? avgConsult : 0) + k × avgConsult + delayOffset + pauseRemaining`.
- For a booked-not-arrived appointment: show the slot time, adjusted by `delayOffset` if > 0 ("around 6:25 PM").
- Display rounded to 5 min ("about 20 min"). Never show less than 5 min unless the patient is NEXT.

### 4.5 Alerts
- **Definition:** `ahead` = (1 if NEXT is occupied) + the number of Waiting entries before this one in `positions()`. The patient IN_CONSULT is not counted.
- `TURN_NEAR`: sent when an entry's `ahead` first becomes ≤ `turnNearThreshold` (default 2). Once per entry. Store `turnNearSentAt`.
- `YOU_ARE_NEXT` on promote; `YOUR_TURN` on start. If start happens within 60 s of promote, skip YOU_ARE_NEXT.
- All alerts are skipped for entries without a WhatsApp number (staff-added, name only).

### 4.6 Walk-in quota
`walkinsIssued(instance)` counts W tokens issued, including adjusted ones. If `walkinsIssued < walkinQuota`, issue directly; otherwise go through overflow (WI-03). A staff `ADD` bypasses the quota but counts toward it.

## 5. Sweeps
- **No-show sweep** at `sessionEnd + noShowGraceMinutes`: BOOKED (never arrived) → NO_SHOW (slotKey NULL), plus NO_SHOW_MISSED. WAITING/NEXT entries left over → staff decides on the dashboard ("Session ended with 2 waiting: extend or mark no-show").
- **Early auto check-in:** ARRIVED_EARLY patients are added to WAITING at `slotStart − earlyCheckInMinutes` (default 30) by a scheduled job.

## 6. Worked examples (turn each into a Vitest case)
Setting (chosen to match the approved mockups): Sat 11 Oct, Evening session **17:10–20:00**, 20-min slots, giving slots 17:10, 17:30, 17:50, 18:10, 18:30, 18:50, 19:10, 19:30 (the 19:50 slot is dropped because it would end after 20:00). Cut-off 60 min, near window ±60, now = Fri 10 Oct 12:00 unless stated.

**E1 Near suggest.** Booked = {17:30, 18:30}. Request 18:00. Candidates within ±60: 17:10 (50), 17:50 (10), 18:10 (10), 18:50 (50). The nearest two are 17:50 and 18:10 (a tie; both kept). Display [5:50 PM] [6:10 PM]. ✔ Matches mockup S1.

**E2 No near slots → Flow.** Booked = every slot from 17:10 to 19:10. Request 18:00. Everything within ±60 is taken, so near = [] and hasAny = true (19:30 is free). The Flow opens on 11 Oct.

**E3 Date only.** Request "Monday morning" (session 10:00–13:00, 20 min, nothing booked, now = Sun 15:00) → earliest two: 10:00, 10:20. (Mockup S2 shows 10:20/10:40 because 10:00 was booked.)

**E4 Cut-off.** Now = Sat 17:30, nothing booked. Request "today 6 pm". With a 60-min cut-off, slots before 18:30 aren't bookable. The candidates within 60 min of 18:00 are 18:30 and 18:50, so show [6:30 PM] [6:50 PM].

**E5 Race.** Booked = {17:30}. Two transactions hold 18:10 concurrently. Exactly one succeeds; the other gets `SlotTaken`. Alternatives = findNearSlots(18:10), which excludes 18:10. Nearest: 17:50 (20) and 18:30 (20), so show [5:50 PM] [6:30 PM].

**E6 Family same slot.** Account has Ramesh booked 18:30. Request for Aarav at 18:30 → taken → next adjacent free slot after 18:30 = 18:50 → SAME_SLOT_FAMILY offer [Book 6:50 PM].

**E7 pickNext basic.** now 18:05. Waiting: A-4 (slot 18:10, arrived 17:55), W-1 (arrived 17:20), W-2 (arrived 17:40). NEXT empty. Due appointments (slot ≤ now+5 = 18:10) → A-4 is due → A-4 first. Then W-1, W-2.

**E8 Fairness.** Last two promoted were W-1, W-2. Waiting: W-3 (arrived 17:45), A-6 (slot 18:50, not due). Guard → A-6 promoted before W-3.

**E9 Late arrival.** A-2 slot 17:30, arrived 17:52 (grace 15 → late). Waiting: W-3 (arrived 17:45). effTime A-2 = 17:52 > W-3 17:45 → W-3 first, then A-2.

**E10 Manual move.** Staff moves W-5 to top → it is promoted next regardless of rules.

**E11 ETA.** Today's completed durations: 12, 8, 10 min → avg 10. IN_CONSULT started 4 min ago → remaining 6. NEXT exists. Entry at Waiting position k=1 → 6 + 10 + 10 = 26 → display "about 25 min". With LATE 15 → 41 → "about 40 min".

**E12 Advance.** IN_CONSULT=A-3, NEXT=W-1, Waiting=[A-4, W-2]. advance() → A-3 COMPLETED, W-1 IN_CONSULT, A-4 NEXT, Waiting=[W-2]. Notifications: W-1 YOUR_TURN, A-4 YOU_ARE_NEXT, W-2 TURN_NEAR (ahead=1, if not sent).

**E13 Walk-in quota.** Quota 10, issued 10 → 11th walk-in → overflow request. Staff Yes at 19:50 → W-11 with expectedAt 19:50 → effTime 19:50 for ordering.

**E14 Token slotIndex.** 18:10 slot in the 17:10-start session → index 3 → A-4.
