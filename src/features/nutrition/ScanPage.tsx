import { Page, TopBar } from '../../components/ui';

// FOUNDATION SHELL — replaced by the feature builder that owns this page. Must not survive to merge.
export function ScanPage() {
  return (
    <Page>
      <TopBar title="Scan barcode" back />
    </Page>
  );
}
