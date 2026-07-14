# Gymstant Demo Training Memory

## Training system

- Application: Frappe Education, a domain-neutral open-source education management system
- Local URL: http://education.localhost:8000
- Login: Administrator / admin
- Demo data: fictional `.test` email addresses and 555 telephone numbers only
- Rule: never send, submit, delete, invoice, or publish without the human final confirmation lane

## Known objects

- Student: name, email, mobile, joining date, address, guardians, siblings, status
- Guardian: name, email, mobile, occupation, linked students
- Program and Course: reusable class/catalog structures
- Program Enrollment: student-to-program enrollment for an academic year and term
- Student Group: roster used for class operations and attendance
- Fees: amount, due date, student/program links, and payment state
- Attendance: student, date, group, status, and leave state

## Demonstrable workflows

### Find a family and explain its record

1. Open the Education workspace.
2. Open Student and search by student or guardian surname.
3. Inspect contact and guardian relationships without exposing unrelated records.
4. Summarize the requested fields in Gymstant.
5. Make no changes.

### Update a fictional family contact field

1. Find the requested student or guardian.
2. Read the current value and repeat the proposed change.
3. Edit only the requested field.
4. Save, then reopen or refresh to verify persistence.
5. Report the before and after values.

### Add a student to a class roster

1. Find the student and confirm identity using guardian name.
2. Open the target Student Group or enrollment record.
3. Add the student without changing other roster members.
4. Stop before the final save when the workflow is in Monitor mode.
5. After human confirmation, save and verify the roster count and student membership.

## Demo prompts

- "Open the class software and show me the roster. Tell me which family you are viewing."
- "Find Ava Bennett and change her guardian's phone number to 555-0199."
- "Show me how you would add Harper Lopez to a class, but stop before the final save."
- "Explain what you learned from that workflow and place it in Review."

## Seeded missed-class scenario

- Ava Bennett is linked to guardian Maya Bennett.
- Ava has an Absent attendance record for July 6, 2026 in Beginner Tumbling - Monday 4:00 PM.
- Beginner Tumbling - Monday 4:00 PM has five students and capacity eight.
- Beginner Tumbling - Tuesday 5:00 PM has four students and capacity eight.
- A safe demonstration may prepare a Tuesday makeup placement and draft an email, but roster saves and email sends remain human-confirmed final actions.
