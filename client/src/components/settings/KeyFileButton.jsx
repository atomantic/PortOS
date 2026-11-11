import { useState } from 'react';
import { FileUp } from 'lucide-react';
import FilePickerButton from '../ui/FilePickerButton';

// A service account key arrives as a downloaded file; this reads it into the
// same write-only draft a pasted key fills, so the save path stays the one
// the paste uses. The text never renders; the caller says which file loaded.
const MAX_KEY_FILE_BYTES = 64 * 1024;

export default function KeyFileButton({ id, accept, disabled, onLoad }) {
  const [error, setError] = useState(null);

  const onChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return undefined;
    if (file.size > MAX_KEY_FILE_BYTES) {
      setError(`${file.name} is too large to be a key file.`);
      return undefined;
    }
    return file.text().then((text) => {
      setError(null);
      onLoad(text.trim(), file.name);
    }).catch((err) => setError(`Could not read ${file.name}: ${err.message}`));
  };

  return (
    <div className="space-y-1">
      <FilePickerButton
        id={id}
        accept={accept}
        disabled={disabled}
        onChange={onChange}
        className="inline-flex items-center justify-center gap-2 px-3 py-2 min-h-[40px] rounded-lg bg-port-border text-gray-200 text-sm hover:bg-port-border/70 whitespace-nowrap"
      >
        <FileUp size={14} />
        Open {accept} key file
      </FilePickerButton>
      {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
    </div>
  );
}
