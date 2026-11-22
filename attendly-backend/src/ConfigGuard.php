<?php
/**
 * ATTENDLY — Configuration guard
 *
 * config/config.php falls back to public development defaults when an
 * environment variable is missing. Those defaults are fine on a laptop but
 * catastrophic in production: the fingerprint matching service is protected
 * only by a shared key, so shipping with the default key means anyone can
 * submit arbitrary scans.
 *
 * This guard runs at bootstrap and refuses to serve a request when a
 * security-critical value is still a known-public default. It never edits
 * config.php; it only inspects the array the loader already produced.
 */

declare(strict_types=1);

namespace Attendly;

final class ConfigGuard
{
    /** The documented development key, published in tools/matching-service/README.md. */
    private const PUBLIC_DEV_MATCHING_KEY = 'attendly-dev-key';

    /**
     * @param array<string,mixed> $config the assembled config array
     * @throws \RuntimeException naming the missing environment variable
     */
    public static function assertSecure(array $config): void
    {
        $problems = [];

        $matchingKey = trim((string) ($config['matching']['key'] ?? ''));
        if ($matchingKey === '') {
            $problems[] = 'MATCHING_KEY is not set (config matching.key is empty).'
                . ' Set it in the environment before starting the API.';
        } elseif (hash_equals(self::PUBLIC_DEV_MATCHING_KEY, $matchingKey)) {
            $problems[] = 'MATCHING_KEY is still the public development default "'
                . self::PUBLIC_DEV_MATCHING_KEY . '".'
                . ' Set MATCHING_KEY to a private value shared with the matching service.';
        }

        $qrSecret = trim((string) ($config['qr_hmac_secret'] ?? ''));
        if ($qrSecret === '') {
            $problems[] = 'QR_HMAC_SECRET is not set (config qr_hmac_secret is empty).';
        } elseif (hash_equals(self::PUBLIC_DEV_MATCHING_KEY, $qrSecret)) {
            $problems[] = 'QR_HMAC_SECRET is still the public development default.'
                . ' Set QR_HMAC_SECRET to a long random value.';
        }

        // SMTP is allowed to be unset during local development: the mailer
        // skips @example.test recipients and a missing password only fails
        // when a real message is sent. Outside development it is required.
        $environment = (string) ($config['app']['env'] ?? 'development');
        if ($environment !== 'development') {
            $smtpPass = trim((string) ($config['smtp_pass'] ?? ''));
            if ($smtpPass === '') {
                $problems[] = 'SMTP_PASS is not set but app.env is "' . $environment . '".';
            }
        }

        if ($problems !== []) {
            throw new \RuntimeException(
                'Insecure configuration: ' . implode(' ', $problems)
            );
        }
    }
}
