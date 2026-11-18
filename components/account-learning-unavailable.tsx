export function AccountLearningUnavailable() {
	return <main role="status" className="flex min-h-0 flex-1 items-center justify-center p-8">
		<section className="max-w-lg text-center">
			<h1 className="font-title text-2xl">Account learning service is unavailable</h1>
			<p className="mt-3 text-sm text-muted-foreground">This signed-in account cannot access learning data until its private account worker is available. No shared local learning store is used as a fallback.</p>
		</section>
	</main>;
}
