import { useState } from 'react';
import { useParams } from 'react-router';
import { Copy, Loader2 } from 'lucide-react';
import PersonaMasterDetail from '../persona/PersonaMasterDetail';
import toast from '../ui/Toast';
import { copyToClipboard } from '../../lib/clipboard';
import {
  listArtists, createArtist, updateArtist, deleteArtist, generateImage, getArtistSubmissionProfile,
  ARTIST_NAME_MAX, ARTIST_GENRE_MAX, ARTIST_BIO_MAX, ARTIST_MUSICAL_STYLE_MAX,
  ARTIST_PHYSICAL_DESCRIPTION_MAX, ARTIST_PORTRAIT_STYLE_MAX, ARTIST_PORTRAIT_IMAGE_URL_MAX,
  ARTIST_SUBMISSION_FIELD_SPECS,
} from '../../services/api';

const FIELDS = [
  { key: 'name', label: 'Name', placeholder: 'Nova Vale', maxLength: ARTIST_NAME_MAX },
  {
    key: 'genre', label: 'Genre', hint: "Primary genre(s) — e.g. 'indie folk, dream pop'.",
    placeholder: 'indie folk, dream pop', maxLength: ARTIST_GENRE_MAX,
  },
  {
    key: 'musicalStyle', label: 'Musical style', type: 'textarea', rows: 4,
    hint: 'Voice / production / instrumentation notes — fed into music-gen prompts.',
    placeholder: 'Warm fingerpicked guitar, breathy close-mic vocals, tape saturation, sparse reverb.', maxLength: ARTIST_MUSICAL_STYLE_MAX,
  },
  {
    key: 'physicalDescription', label: 'Physical description', type: 'textarea', rows: 3,
    hint: 'Subject of the portrait — appearance, age, expression, wardrobe.',
    placeholder: 'Androgynous figure, late 20s, cropped platinum hair, vintage band tee, calm gaze.', maxLength: ARTIST_PHYSICAL_DESCRIPTION_MAX,
  },
  {
    key: 'portraitStyle', label: 'Portrait style', type: 'textarea', rows: 3,
    hint: 'Art / photography direction for the portrait render.',
    placeholder: 'Moody film photograph, neon backlight, grainy 35mm, shallow depth of field.', maxLength: ARTIST_PORTRAIT_STYLE_MAX,
  },
];

// Editor copy for the press & submission profile; caps, labels and grouping
// come from the shared spec so the server export reads the same.
const SUBMISSION_UI = {
  creditName: { hint: 'The name festivals print in credits, if it differs from the artist name.', placeholder: 'Nova Vale' },
  pronouns: { placeholder: 'they/them' },
  location: { placeholder: 'Portland, Oregon, USA' },
  contactEmail: { inputType: 'email', hint: 'Where festivals should write.', placeholder: 'nova@example.com' },
  bioOneLine: { type: 'textarea', rows: 2, counter: true, hint: 'One sentence for social profiles and tight form fields.', placeholder: 'Nova Vale writes folk songs for the end of the night.' },
  bioShort: { type: 'textarea', rows: 4, counter: true, hint: 'About 50–100 words, for most festival forms.', placeholder: 'Nova Vale is a songwriter and video maker…' },
  artistStatement: { type: 'textarea', rows: 5, counter: true, hint: 'What you make and why; festivals often ask for a director statement.' },
  aiStatement: { type: 'textarea', rows: 4, counter: true, hint: 'How AI tools are and are not used. Many festivals require this.', placeholder: 'Music generated with … Lyrics, story and editing are my own.' },
  highlights: { type: 'textarea', rows: 4, counter: true, hint: 'Releases, screenings, selections and awards, one per line. Only real ones.' },
  otherLinks: { type: 'textarea', rows: 3, hint: 'One per line: label, then the link.', placeholder: 'Linktree https://example.com/nova' },
  submissionNotes: { type: 'textarea', rows: 3, hint: 'Standing rules for agents filling forms for you.', placeholder: 'Always credit the artist as Nova Vale. Never claim a premiere.' },
};

const submissionField = ({ key, label, max }) => ({
  key, label, maxLength: max,
  ...(key.endsWith('Url') ? { inputType: 'url', placeholder: 'https://…' } : {}),
  ...SUBMISSION_UI[key],
});

const specsIn = (section) => ARTIST_SUBMISSION_FIELD_SPECS.filter((spec) => spec.section === section).map(submissionField);

const SECTIONS = [
  { id: 'identity', title: 'Credits & contact', fields: specsIn('identity') },
  {
    id: 'bio', title: 'Bios',
    hint: 'Festival and distributor forms ask for different lengths. Agents copy these as written.',
    fields: [
      ...specsIn('bio'),
      {
        key: 'bio', label: 'Full bio', type: 'textarea', rows: 6, counter: true, hint: 'The long version, for press kits and websites.',
        placeholder: 'Nova Vale is a songwriter working at the seam of folk and ambient…', maxLength: ARTIST_BIO_MAX,
      },
    ],
  },
  { id: 'statements', title: 'Statements & history', fields: specsIn('statements') },
  { id: 'links', title: 'Links', fields: specsIn('links') },
  { id: 'notes', title: 'Notes for agents', fields: specsIn('notes') },
];

function CopyProfileButton({ selected, dirty }) {
  const [copying, setCopying] = useState(false);
  const copy = async () => {
    setCopying(true);
    const result = await getArtistSubmissionProfile(selected.id, { silent: true }).catch((err) => {
      toast.error(err.message || 'Could not load the profile');
      return null;
    });
    setCopying(false);
    if (result?.markdown) await copyToClipboard(result.markdown, 'Profile copied');
  };
  return (
    <button
      type="button"
      onClick={copy}
      disabled={copying || dirty}
      title={dirty ? 'Save first, so the copy matches what you see' : 'Copy the press & submission profile as Markdown'}
      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent disabled:opacity-50 min-h-[44px]"
    >
      {copying ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />} Copy profile
    </button>
  );
}

const renderDetailActions = (props) => <CopyProfileButton {...props} />;

const PORTRAIT = {
  label: 'Portrait', fieldLabel: 'Portrait image', imageKey: 'portraitImageUrl',
  descriptionKey: 'physicalDescription', styleKey: 'portraitStyle', styleLabel: 'Portrait style',
  maxLength: ARTIST_PORTRAIT_IMAGE_URL_MAX,
  hint: 'Optional — generate from the description + style, choose or upload one via the gallery, or paste a URL.',
  generateTitle: 'Generate a portrait from the description + style',
  buildPrompt: (form) => {
    const description = form.physicalDescription.trim();
    const style = form.portraitStyle.trim();
    const subject = description ? `Music artist portrait. ${description}` : 'Music artist promotional portrait.';
    return style ? `${subject} ${style}` : subject;
  },
};

export default function ArtistsManager() {
  const { id } = useParams();
  return (
    <PersonaMasterDetail
      basePath="/music/artists"
      selectedId={id}
      intro="Artist personas are reusable across albums and tracks — the byline plus the genre, musical style, and the physical description + style used to generate (or upload) an artist portrait. The bios, credits and links below are what agents use when filling festival and distributor forms for you."
      singular="Artist"
      plural="Artists"
      fields={FIELDS}
      listSecondaryKey="genre"
      portrait={PORTRAIT}
      listRecords={listArtists}
      createRecord={createArtist}
      updateRecord={updateArtist}
      deleteRecord={deleteArtist}
      generateImage={generateImage}
      sections={SECTIONS}
      detailActions={renderDetailActions}
    />
  );
}
