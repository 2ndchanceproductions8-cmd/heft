import { Page, TopBar } from '../../components/ui';

// FOUNDATION SHELL — replaced by the feature builder that owns this page. Must not survive to merge.
export function DiaryPage() {
  return (
    <Page tabBar>
      <TopBar title="Food" back />
    </Page>
  );
}
