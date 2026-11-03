// The Send by email form: quick checks in the browser (the server checks it all again).

export const MAX_RECIPIENTS = 10;

// One address: something@domain.tld, no spaces. Deliberately simple; the server's
// email-validator has the final word.
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/;

/** "a@x.com, b@y.com; c@z.com" → ["a@x.com", "b@y.com", "c@z.com"]. */
export function splitAddresses(text) {
  return (text ?? "")
    .split(/[\s,;]+/)
    .map((a) => a.trim())
    .filter(Boolean);
}

export const isEmail = (address) => EMAIL.test(address);

/** Problems by field name ({} when the form can be sent). */
export function checkEmailForm({ to, cc, subject, formats }) {
  const problems = {};
  const toList = splitAddresses(to);
  const ccList = splitAddresses(cc);
  const badTo = toList.filter((a) => !isEmail(a));
  const badCc = ccList.filter((a) => !isEmail(a));
  if (toList.length === 0) problems.to = "Add at least one recipient.";
  else if (badTo.length) problems.to = `Not an email address: ${badTo.join(", ")}`;
  if (badCc.length) problems.cc = `Not an email address: ${badCc.join(", ")}`;
  const everyone = new Set([...toList, ...ccList].map((a) => a.toLowerCase()));
  if (!problems.to && !problems.cc && everyone.size > MAX_RECIPIENTS) {
    problems.to = `At most ${MAX_RECIPIENTS} recipients (To and CC together).`;
  }
  if (!subject?.trim()) problems.subject = "Add a subject.";
  else if (/[\r\n]/.test(subject)) problems.subject = "The subject must be one line.";
  if (!formats?.length) problems.formats = "Choose at least one format.";
  return problems;
}
