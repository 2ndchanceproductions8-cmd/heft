import { Page, TopBar } from '../../components/ui';

// FOUNDATION SHELL — replaced by the feature builder that owns this page. Must not survive to merge.
export function NutritionSettingsPage() {
  return (
    <Page tabBar>
      <TopBar title="Food settings" back />
    </Page>
  );
}
