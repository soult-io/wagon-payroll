# Sign in with a passkey

A passkey lets your phone, computer or password manager unlock Wagon Payroll
with your fingerprint, face, or device PIN. There is nothing to type, and a
fake website can't trick you into handing it over. A passkey is an extra way
in: your password and authenticator app keep working as before.

## Add a passkey

1. Open **My settings → Sign-in and security → Passkeys**.
2. Choose **Add a passkey**.
   - If you signed in more than a few minutes ago, you'll be asked to sign in
     again first. This keeps someone who finds your computer unlocked from
     adding their own passkey.
   - If you signed in with a backup code, you can't add a passkey. Sign out
     and sign in again with your authenticator code first.
3. Give it a name if you like (for example "Work laptop"), choose
   **Continue**, and confirm on your device.

You can have up to 10 passkeys.

## Sign in with a passkey

On the sign-in page, either:

- pick your passkey from the suggestions in the **Email** field, or
- choose **Sign in with a passkey**.

Your device asks for your fingerprint, face, or device PIN. That's the whole
sign-in: no password or code is asked.

## Rename or remove a passkey

Both are on the same **Passkeys** card. Removing a passkey also needs a recent
sign-in. If you lost the device, tick **Also sign me out on all other
devices** when you remove it.

Removing a passkey here doesn't delete it from your device. To stop your
device offering it, delete it in your password manager or device settings
too.

## Lost a device?

Sign in with your password and authenticator code (or a backup code), remove
the lost device's passkey, and sign out your other devices. If you've lost
everything, ask your administrator to reset your account. A reset also
removes your passkeys.

## If something goes wrong

| You see | What to do |
|---|---|
| This passkey is no longer linked to your account. | It was removed from your account. Sign in with your password, then delete it from your device. |
| Your device didn't confirm it's you (fingerprint, face, or device PIN). | Turn on a screen lock on the device, then try again. |
| Passkey sign-in was cancelled. | Nothing went wrong. Try again, or sign in with your password. |
| Too many sign-in attempts. | Wait a minute, then try again. |
| Passkeys aren't available here. | Use an up-to-date browser and the app's https address. |

## For people who host Wagon Payroll themselves

- Passkeys work only over **https**, or on `localhost` for local testing. On
  a plain http address or a bare IP address, the passkey options are hidden
  and everyone signs in with a password and code.
- Passkeys are tied to the exact host name in `BASE_URL` (see
  [deployment.md](deployment.md)). If you move the app to a different
  address, existing passkeys stop working and people need to add new ones.
  Their password and authenticator app still work.
- A QA or staging copy on a different address has its own, separate
  passkeys.
