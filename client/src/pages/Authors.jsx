import { FilePen, Plus } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import PageHeader from '../components/PageHeader';
import PersonaMasterDetail from '../components/persona/PersonaMasterDetail';
import {
  listAuthors, createAuthor, updateAuthor, deleteAuthor, generateImage,
  AUTHOR_NAME_MAX, AUTHOR_WRITING_STYLE_MAX, AUTHOR_BIO_MAX,
  AUTHOR_PHYSICAL_DESCRIPTION_MAX, AUTHOR_HEADSHOT_STYLE_MAX, AUTHOR_HEADSHOT_IMAGE_URL_MAX,
} from '../services/api';

const FIELDS = [
  { key: 'name', label: 'Name', placeholder: 'Jane Doe', maxLength: AUTHOR_NAME_MAX },
  {
    key: 'writingStyle', label: 'Writing style', type: 'textarea', rows: 4,
    hint: 'Voice / tone / craft notes — fed into stage prompts.',
    placeholder: 'Spare, noir-tinged prose; short declarative sentences; dry wit.', maxLength: AUTHOR_WRITING_STYLE_MAX,
  },
  {
    key: 'bio', label: 'Bio', type: 'textarea', rows: 4,
    hint: 'About-the-author blurb for the back cover.', placeholder: 'Jane Doe is the author of…', maxLength: AUTHOR_BIO_MAX,
  },
  {
    key: 'physicalDescription', label: 'Physical description', type: 'textarea', rows: 3,
    hint: 'Subject of the cover headshot — appearance, age, expression.',
    placeholder: 'Woman in her 40s, silver-streaked dark hair, warm gaze, slight smile.', maxLength: AUTHOR_PHYSICAL_DESCRIPTION_MAX,
  },
  {
    key: 'headshotStyle', label: 'Headshot style', type: 'textarea', rows: 3,
    hint: 'Art / photography direction for the headshot render.',
    placeholder: 'Studio portrait, soft Rembrandt lighting, muted background, 85mm.', maxLength: AUTHOR_HEADSHOT_STYLE_MAX,
  },
];

const INTRO = 'Author personas are reusable across series — the cover byline plus the writing voice, bio, and the physical description + style used to generate a book-cover author headshot. Link one to a series from the Series Pipeline.';

const PORTRAIT = {
  label: 'Headshot', fieldLabel: 'Headshot image', imageKey: 'headshotImageUrl',
  descriptionKey: 'physicalDescription', styleKey: 'headshotStyle', styleLabel: 'Headshot style',
  maxLength: AUTHOR_HEADSHOT_IMAGE_URL_MAX,
  hint: 'Optional — generate from the description + style, choose or upload one via the gallery, or paste a URL. Used on covers.',
  generateTitle: 'Generate a headshot from the description + style',
  buildPrompt: (form) => {
    const description = form.physicalDescription.trim();
    const style = form.headshotStyle.trim();
    const subject = description ? `Author headshot portrait. ${description}` : 'Professional author headshot portrait.';
    return style ? `${subject} ${style}` : subject;
  },
};

export default function Authors() {
  const { authorId } = useParams();
  const navigate = useNavigate();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        icon={FilePen}
        title="Authors"
        subtitle={INTRO}
        actions={(
          <button
            type="button"
            onClick={() => navigate('/authors/new')}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm"
          >
            <Plus size={16} aria-hidden="true" />
            New Author
          </button>
        )}
      />
      <div className="flex-1 min-h-0 overflow-auto p-4">
        <PersonaMasterDetail
          hideTitle
          basePath="/authors"
          selectedId={authorId}
          title="Authors"
          titleIcon={FilePen}
          intro={INTRO}
          singular="Author"
          plural="Authors"
          fields={FIELDS}
          portrait={PORTRAIT}
          listRecords={listAuthors}
          createRecord={createAuthor}
          updateRecord={updateAuthor}
          deleteRecord={deleteAuthor}
          generateImage={generateImage}
        />
      </div>
    </div>
  );
}
