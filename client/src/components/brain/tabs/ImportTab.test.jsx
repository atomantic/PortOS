import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { previewChatgptImport, runChatgptImport, uploadChatgptZip } from '../../../services/apiBrain.js';
import toast from '../../ui/Toast';
import ImportTab from './ImportTab';

vi.mock('../../../services/apiBrain.js', () => ({
  previewChatgptImport: vi.fn(),
  runChatgptImport: vi.fn(),
  uploadChatgptZip: vi.fn(),
}));

vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn() } }));

const exportData = [
  { id: 'example-1', title: 'Example conversation' },
  { id: 'example-2', title: 'Second example' },
];
const importResult = { ok: true, imported: 2, skipped: 0, archived: 2, results: [] };

function renderImport() {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/brain/import']}>
      <Routes>
        <Route path="/brain/import" element={<ImportTab />} />
        <Route path="/brain/notes" element={<h1>Brain Notes</h1>} />
        <Route path="/timeline" element={<h1>Timeline</h1>} />
      </Routes>
    </MemoryRouter>
  );
  return user;
}

async function openUpload() {
  const user = renderImport();
  await user.click(screen.getByRole('button', { name: /^ChatGPT/ }));
  await user.click(screen.getByRole('button', { name: 'I have the file' }));
  return {
    user,
    input: screen.getByLabelText(/Drop your export \.zip here/),
  };
}

function jsonExport(contents = JSON.stringify(exportData)) {
  return new File([contents], 'conversations.json', { type: 'application/json' });
}

beforeEach(() => vi.resetAllMocks());

it.each([
  ['Obsidian', 'Brain Notes'],
  ['Gmail', 'Timeline'],
  ['Spotify', 'Timeline'],
  ['Google location history', 'Timeline'],
  ['Discord', 'Timeline'],
  ['WhatsApp', 'Timeline'],
  ['Browser history', 'Timeline'],
  ['YouTube', 'Timeline'],
])('routes the %s source to %s', async (source, destination) => {
  const user = renderImport();
  await user.click(screen.getByRole('button', { name: new RegExp(`^${source}`) }));
  expect(screen.getByRole('heading', { name: destination })).toBeInTheDocument();
});

it('shows the ChatGPT instructions and returns to the source picker on exit', async () => {
  const user = renderImport();
  await user.click(screen.getByRole('button', { name: /^ChatGPT/ }));

  expect(screen.getByRole('heading', { name: 'Import from ChatGPT' })).toBeInTheDocument();
  expect(screen.getByText('Confirm export')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'All sources' }));
  expect(screen.getByRole('heading', { name: 'Import from a third-party source' })).toBeInTheDocument();
});

it('rejects an unsupported dropped file and stays on upload', async () => {
  const { input } = await openUpload();
  const file = new File(['example'], 'export.txt', { type: 'text/plain' });
  fireEvent.drop(screen.getByText('Drop your export .zip here'), { dataTransfer: { files: [file] } });

  expect(screen.getByRole('alert')).toHaveTextContent('Select your ChatGPT export .zip');
  expect(input).toBeInTheDocument();
  expect(previewChatgptImport).not.toHaveBeenCalled();
});

it('rejects malformed JSON before asking the server for a preview', async () => {
  const { user, input } = await openUpload();
  await user.upload(input, jsonExport('{'));

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not parse JSON');
  expect(input).toBeInTheDocument();
  expect(previewChatgptImport).not.toHaveBeenCalled();
});

it('shows a server preview rejection and stays on upload', async () => {
  previewChatgptImport.mockResolvedValueOnce({ ok: false, error: 'No conversations in this export' });
  const { user, input } = await openUpload();
  await user.upload(input, jsonExport('[]'));

  expect(await screen.findByRole('alert')).toHaveTextContent('No conversations in this export');
  expect(input).toBeEnabled();
  expect(previewChatgptImport).toHaveBeenCalledExactlyOnceWith([]);
  expect(screen.queryByRole('button', { name: 'Run import' })).not.toBeInTheDocument();
});

it('streams a ZIP with the selected options and reports imported conversations and assets', async () => {
  const { promise, resolve } = Promise.withResolvers();
  uploadChatgptZip.mockReturnValueOnce(promise);
  const { user, input } = await openUpload();
  const zip = new File(['example archive'], 'export.zip', { type: 'application/zip' });
  await user.upload(input, zip);

  expect(screen.getByText(/Ready to import/)).toHaveTextContent('export.zip');
  expect(previewChatgptImport).not.toHaveBeenCalled();

  const tags = screen.getByRole('textbox', { name: 'Tags' });
  await user.clear(tags);
  await user.type(tags, ' archive , , work ');
  const skipEmpty = screen.getByRole('checkbox', { name: /Skip empty conversations/ });
  expect(skipEmpty).toBeChecked();
  await user.click(skipEmpty);
  await user.click(screen.getByRole('button', { name: 'Run import' }));

  expect(screen.getByText('Uploading & extracting your export…')).toBeInTheDocument();
  expect(uploadChatgptZip).toHaveBeenCalledExactlyOnceWith(zip, { tags: 'archive,work', skipEmpty: false, silent: true });
  expect(runChatgptImport).not.toHaveBeenCalled();

  resolve({ ...importResult, assetStats: { assetCount: 5 } });
  expect(await screen.findByRole('heading', { name: 'Import complete' })).toBeInTheDocument();
  expect(screen.getByText(/2 imported/)).toHaveTextContent('5 assets');
  expect(toast.success).toHaveBeenCalledExactlyOnceWith('Imported 2 conversations and 5 assets into Memory');
});

it('previews JSON and preserves the file and options for retry after a failed import', async () => {
  previewChatgptImport.mockResolvedValueOnce({
    ok: true,
    summary: {
      totalConversations: 2,
      totalMessages: 24,
      totalChars: 560,
      gizmoCount: 0,
      earliest: null,
      latest: null,
    },
    conversations: [{ ...exportData[0], messageCount: 12, createTime: null }],
  });
  const { promise, reject } = Promise.withResolvers();
  runChatgptImport
    .mockReturnValueOnce(promise)
    .mockResolvedValueOnce(importResult);
  const { user, input } = await openUpload();
  await user.upload(input, jsonExport());

  expect(await screen.findByText(/Found/)).toHaveTextContent('Found 2 conversations in conversations.json');
  expect(screen.getByText('24')).toBeInTheDocument();
  expect(screen.getByText('560')).toBeInTheDocument();
  expect(screen.getByText('Example conversation')).toBeInTheDocument();
  expect(previewChatgptImport).toHaveBeenCalledExactlyOnceWith(exportData);

  const tags = screen.getByRole('textbox', { name: 'Tags' });
  await user.clear(tags);
  await user.type(tags, ' legacy, , reference ');
  await user.click(screen.getByRole('checkbox', { name: /Skip empty conversations/ }));
  await user.click(screen.getByRole('button', { name: 'Run import' }));

  const options = { tags: ['legacy', 'reference'], skipEmpty: false };
  expect(screen.getByText('Importing conversations into Memory…')).toBeInTheDocument();
  expect(runChatgptImport).toHaveBeenCalledExactlyOnceWith(exportData, options);

  reject(new Error('Could not write to Memory'));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Could not write to Memory');
  expect(screen.getByRole('textbox', { name: 'Tags' })).toHaveValue(' legacy, , reference ');
  expect(screen.getByRole('checkbox', { name: /Skip empty conversations/ })).not.toBeChecked();

  await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Run import' }));

  expect(await screen.findByRole('heading', { name: 'Import complete' })).toBeInTheDocument();
  expect(runChatgptImport).toHaveBeenCalledTimes(2);
  expect(runChatgptImport).toHaveBeenLastCalledWith(exportData, options);
  expect(previewChatgptImport).toHaveBeenCalledTimes(1);
  expect(uploadChatgptZip).not.toHaveBeenCalled();
});
