export default function SignInButtons({
  callbackURL,
}: {
  callbackURL: string;
}) {
  return (
    <div className="auth-actions">
      <a
        className="auth-provider-button chatgpt"
        href={`/signin-with-chatgpt?return_to=${encodeURIComponent(callbackURL)}`}
      >
        <span className="provider-letter chatgpt" aria-hidden="true">
          C
        </span>
        Continue with ChatGPT
      </a>
    </div>
  );
}
