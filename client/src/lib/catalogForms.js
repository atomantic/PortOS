// Alternate forms of a cast record (other ages, eras, looks/styles). The
// record's own fields are its canonical present-story form; `payload.forms`
// holds the rest. A form's sheet is tagged `sheet:<variant>@<formId>` and a
// reference is tied to a form by `library.variant.formId`.
import { uuidv4 } from './uuid';

export const FORM_ROLE_SEPARATOR = '@';

// Short ids: the sheet role must fit the 64-char media role cap.
export const newFormId = () => `form-${uuidv4().slice(0, 8)}`;

// Payload field the canonical form's age lives in, per type (objects have none).
const AGE_FIELDS = { character: 'age', place: 'era' };
export const formAgeField = (type) => AGE_FIELDS[type] || null;
export const formAgeLabel = (type) => (type === 'character' ? 'Age' : 'Era');

export const formsOf = (payload) => (Array.isArray(payload?.forms)
  ? payload.forms.filter((f) => f && typeof f === 'object' && typeof f.id === 'string')
  : []);

// `sheet:turnaround@form-1a2b3c4d` → { variant: 'turnaround', formId: 'form-1a2b3c4d' }.
export function splitSheetRole(role, prefix = 'sheet:') {
  const rest = typeof role === 'string' && role.startsWith(prefix) ? role.slice(prefix.length) : '';
  const at = rest.indexOf(FORM_ROLE_SEPARATOR);
  return at === -1 ? { variant: rest, formId: null } : { variant: rest.slice(0, at), formId: rest.slice(at + 1) || null };
}
