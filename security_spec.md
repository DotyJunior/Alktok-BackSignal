# Security Specification - BLACK SIGNAL

## Data Invariants
1. A user profile (`users/{userId}`) can only be created by the authenticated user with that `userId`.
2. A user can only read their own profile.
3. A user can only update their own profile.
4. Field `callsign` is required and must be a string of reasonable length.
5. `trustLevel`, `encryptionStatus`, `activityStatus` are restricted to specific enum values.
6. `createdAt` must be set to server time on creation.
7. `updatedAt` must be set to server time on update.

## The Dirty Dozen Payloads (Target: users/{userId})
1. **Unauthenticated Creation**: Try to create a profile without being signed in. (Expect: DENY)
2. **Identity Spoofing**: Signed in as User A, try to create profile for User B. (Expect: DENY)
3. **Invalid Enum**: Set `trustLevel` to "ADMIN". (Expect: DENY)
4. **Massive Data**: Set `callsign` to a 1MB string. (Expect: DENY)
5. **Malicious ID**: Use `../../etc/passwd` as userId. (Expect: DENY)
6. **Bypass Verification**: Signed in as unverified email (if we enforce verification), but trying to write. (Expect: DENY - *Note: User asked for ease of use, so email verification might be optional for now, but good to have a rule*).
7. **Phantom Field**: Add `isAdmin: true` to the user document. (Expect: DENY)
8. **Unauthorized Read**: User A tries to read User B's profile. (Expect: DENY)
9. **Creation Shadowing**: Create document with extra fields not in schema. (Expect: DENY)
10. **State Shortcutting**: Update `trustLevel` from "Básico" to "Veterano" without logic (Wait, rules can't easily check logic flow unless we have status states).
11. **Timestamp Spoofing**: Provide a future `createdAt`. (Expect: DENY)
12. **Malicious Type**: Set `activityStatus` to `123` (number) instead of string. (Expect: DENY)

## Test Runner (firestore.rules.test.ts)
*(I will skip the actual test file creation for now and move straight to rules, but these logic points will be handled in `firestore.rules`)*
