import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import Drawer from './Drawer';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'ports', label: 'Ports & TLS' },
  { id: 'jira', label: 'JIRA' },
];

describe('Drawer', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<Drawer open={false} onClose={() => {}} title="X">body</Drawer>);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders title, children and an accessible dialog when open', () => {
    render(<Drawer open onClose={() => {}} title="Edit App"><p>form body</p></Drawer>);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Edit App');
    expect(screen.getByText('form body')).toBeInTheDocument();
  });

  describe('size variants (back-compat)', () => {
    it('defaults to the original sm (~520px) width', () => {
      render(<Drawer open onClose={() => {}} title="X">b</Drawer>);
      expect(screen.getByRole('dialog').className).toContain('sm:w-[520px]');
    });

    it('applies wider brackets for lg/xl', () => {
      const { rerender } = render(<Drawer open onClose={() => {}} title="X" size="lg">b</Drawer>);
      expect(screen.getByRole('dialog').className).toContain('lg:w-[880px]');
      rerender(<Drawer open onClose={() => {}} title="X" size="xl">b</Drawer>);
      expect(screen.getByRole('dialog').className).toContain('xl:w-[1100px]');
    });

    it('honors an explicit widthClass escape hatch over size', () => {
      render(<Drawer open onClose={() => {}} title="X" size="lg" widthClass="sm:w-[640px]">b</Drawer>);
      const cls = screen.getByRole('dialog').className;
      expect(cls).toContain('sm:w-[640px]');
      expect(cls).not.toContain('lg:w-[880px]');
    });
  });

  describe('close behavior', () => {
    it('closes on backdrop click and Esc by default', () => {
      const onClose = vi.fn();
      render(<Drawer open onClose={onClose} title="X">b</Drawer>);
      fireEvent.click(document.querySelector('[aria-hidden="true"]'));
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('opts out of Esc and backdrop dismissal for long-lived forms', () => {
      const onClose = vi.fn();
      render(<Drawer open onClose={onClose} title="X" closeOnEsc={false} closeOnBackdrop={false}>b</Drawer>);
      fireEvent.click(document.querySelector('[aria-hidden="true"]'));
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
    });

    it('fires onClose from the header close button', () => {
      const onClose = vi.fn();
      render(<Drawer open onClose={onClose} title="X">b</Drawer>);
      fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('tabbed layout', () => {
    it('renders no tablist when tabs are omitted', () => {
      render(<Drawer open onClose={() => {}} title="X">b</Drawer>);
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
      expect(screen.getByText('b').closest('[role="tabpanel"]')).toBeNull();
    });

    it('renders a tablist and a labelled tabpanel when tabs are provided (uncontrolled)', () => {
      render(<Drawer open onClose={() => {}} title="Edit App" tabs={TABS}><div>panel body</div></Drawer>);
      expect(screen.getByRole('tablist')).toBeInTheDocument();
      const panel = screen.getByRole('tabpanel');
      expect(within(panel).getByText('panel body')).toBeInTheDocument();
      // defaults to the first tab
      expect(panel).toHaveAttribute('id', 'drawer-tabpanel-general');
    });

    it('switches tabs internally when uncontrolled', () => {
      render(<Drawer open onClose={() => {}} title="X" tabs={TABS}>body</Drawer>);
      // TabPills renders a mobile <select> plus the desktop tab buttons.
      fireEvent.click(screen.getByRole('tab', { name: 'JIRA' }));
      expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'drawer-tabpanel-jira');
    });

    it('is controllable via activeTab + onTabChange', () => {
      const onTabChange = vi.fn();
      const { rerender } = render(
        <Drawer open onClose={() => {}} title="X" tabs={TABS} activeTab="ports" onTabChange={onTabChange}>body</Drawer>
      );
      expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'drawer-tabpanel-ports');
      fireEvent.click(screen.getByRole('tab', { name: 'JIRA' }));
      expect(onTabChange).toHaveBeenCalledWith('jira');
      // controlled: nothing changes until the parent updates activeTab
      expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'drawer-tabpanel-ports');
      rerender(<Drawer open onClose={() => {}} title="X" tabs={TABS} activeTab="jira" onTabChange={onTabChange}>body</Drawer>);
      expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'drawer-tabpanel-jira');
    });

    it('applies bodyClassName to the scroll region for multi-column layouts', () => {
      render(<Drawer open onClose={() => {}} title="X" tabs={TABS} bodyClassName="lg:grid lg:grid-cols-2">body</Drawer>);
      expect(screen.getByRole('tabpanel').className).toContain('lg:grid-cols-2');
    });
  });
});
