use topcoat::{
    Result,
    context::Cx,
    router::{StatusCode, error::NotFoundError, layout},
    view::view,
};

const NOT_FOUND_REDIRECT_DELAY_SECONDS: u8 = 2;

#[layout("/")]
async fn root_layout(cx: &Cx, slot: Result) -> Result {
    match slot {
        Err(error) if error.downcast_ref::<NotFoundError>().is_some() => {
            not_found_document(cx).await
        }
        content => content,
    }
}

async fn not_found_document(cx: &Cx) -> Result {
    let __cx = cx;
    view! {
        (StatusCode::NOT_FOUND)
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta http-equiv="refresh" content=(format!("{NOT_FOUND_REDIRECT_DELAY_SECONDS}; url=/"))>
                <link rel="stylesheet" href=(topcoat::tailwind::stylesheet!())>
                <title>"Page not found · Workflow Console"</title>
            </head>
            <body class="grid min-h-screen place-items-center bg-canvas p-4 text-text-primary">
                <main class="w-full max-w-xl rounded-panel border border-border bg-surface p-6 shadow-panel" aria-labelledby="not-found-title">
                    <p class="text-xs font-semibold uppercase tracking-label text-status-error">"404"</p>
                    <h1 id="not-found-title" class="mt-2 text-3xl font-semibold tracking-title">"Page not found"</h1>
                    <p class="mt-4 text-text-secondary">"This route is not part of the local workflow console. Redirecting to the default workflow."</p>
                    <a class="mt-6 inline-flex min-h-[var(--control-min)] items-center rounded-control border border-accent-hover bg-accent px-4 font-semibold text-text-primary shadow-inset" href="/">"Return now"</a>
                </main>
            </body>
        </html>
    }
}
