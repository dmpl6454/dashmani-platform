import { Card, CardHeader, CardTitle, CardContent } from "@dashmani/ui";

export default function ClientHome() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Card className="max-w-md text-center">
        <CardHeader>
          <div className="text-3xl font-bold text-brand-blue">Digital Sukoon</div>
          <CardTitle>Client Campaign Portal</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground mb-4">
            Your campaign dashboard is coming soon. We are building something amazing for you.
          </p>
          <p className="text-sm text-muted-foreground">Phase 1E — Coming Next</p>
        </CardContent>
      </Card>
    </div>
  );
}
