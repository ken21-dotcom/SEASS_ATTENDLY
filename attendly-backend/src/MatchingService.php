<?php
/**
 * ATTENDLY — local fingerprint matching service client.
 *
 * Talks to tools/matching-service over loopback only. Images and templates
 * are held in memory for the duration of one request; nothing is logged or
 * written to disk here.
 */

declare(strict_types=1);

namespace Attendly;

use RuntimeException;

/** The service is unreachable, misconfigured, or returned an unexpected status. */
final class MatchingServiceUnavailable extends RuntimeException
{
}

/** The service could not read the supplied image, or rejected the payload. */
final class MatchingServiceRejected extends RuntimeException
{
}

final class MatchingService
{
    private const MAX_IMAGE_CHARS = 2_000_000;

    public function __construct(
        private string $baseUrl,
        private string $key,
        private int $timeoutSeconds = 5
    ) {
        $this->baseUrl = rtrim($this->baseUrl, '/');
    }

    /**
     * Build the client from config.php. MATCHING_KEY in the environment wins
     * so the key never has to be committed to a config file.
     *
     * @param array<string,mixed> $config
     */
    public static function fromConfig(array $config): self
    {
        $matching = is_array($config['matching'] ?? null) ? $config['matching'] : [];
        $key = getenv('MATCHING_KEY');
        if ($key === false || trim($key) === '') {
            $key = (string) ($matching['key'] ?? '');
        }
        $url = getenv('MATCHING_URL');
        if ($url === false || trim($url) === '') {
            $url = (string) ($matching['url'] ?? 'http://127.0.0.1:8090');
        }

        return new self(
            trim($url),
            trim($key),
            max(1, (int) ($matching['timeout_seconds'] ?? 5))
        );
    }

    public function isConfigured(): bool
    {
        return $this->key !== '';
    }

    /**
     * POST /template — turn one base64 image into a SourceAFIS template.
     *
     * @return string base64 template
     */
    public function template(string $imageBase64): string
    {
        $response = $this->post('/template', ['image' => $this->checkImage($imageBase64)]);

        $template = $response['template'] ?? null;
        if (!is_string($template) || $template === '') {
            throw new MatchingServiceRejected('The matching service returned no template.');
        }
        return $template;
    }

    /**
     * POST /identify — compare one image against candidate template lists.
     *
     * @param array<int,array{id:int,templates:string[]}> $candidates
     * @return int|null matched candidate id, or null below the threshold
     */
    public function identify(string $imageBase64, array $candidates): ?int
    {
        return $this->identifyDetailed($imageBase64, $candidates)['matchedId'];
    }

    /**
     * POST /identify with the diagnostics the kiosk shows in ?debug=1:
     * best score, threshold, and the finger whose template produced it.
     *
     * @param array<int,array{id:int,templates:string[],fingers?:array<int,string|null>}> $candidates
     * @return array{matchedId:?int,score:?float,threshold:?float,finger:?string}
     */
    public function identifyDetailed(string $imageBase64, array $candidates): array
    {
        if ($candidates === []) {
            return ['matchedId' => null, 'score' => null, 'threshold' => null, 'finger' => null];
        }

        $payload = [];
        foreach ($candidates as $candidate) {
            $templates = array_values(array_map('strval', $candidate['templates'] ?? []));
            $entry = [
                'id' => (int) $candidate['id'],
                'templates' => $templates,
            ];
            $fingers = $candidate['fingers'] ?? null;
            if (is_array($fingers) && count($fingers) === count($templates)) {
                $entry['fingers'] = array_values(array_map(
                    static fn($finger): ?string => is_string($finger) && trim($finger) !== ''
                        ? strtolower(trim($finger))
                        : null,
                    $fingers
                ));
            }
            $payload[] = $entry;
        }

        $response = $this->post('/identify', [
            'image' => $this->checkImage($imageBase64),
            'candidates' => $payload,
        ]);

        $threshold = isset($response['threshold']) && is_numeric($response['threshold'])
            ? (float) $response['threshold']
            : null;
        $bestScore = isset($response['bestScore']) && is_numeric($response['bestScore'])
            ? (float) $response['bestScore']
            : null;

        $match = $response['match'] ?? null;
        if ($match === null) {
            return [
                'matchedId' => null,
                'score' => $bestScore,
                'threshold' => $threshold,
                'finger' => null,
            ];
        }
        if (!is_array($match) || !isset($match['id'])) {
            throw new MatchingServiceRejected('The matching service returned an invalid match.');
        }

        $score = isset($match['score']) && is_numeric($match['score'])
            ? (float) $match['score']
            : $bestScore;
        $finger = isset($match['finger']) && is_string($match['finger']) && trim($match['finger']) !== ''
            ? strtolower(trim($match['finger']))
            : null;

        return [
            'matchedId' => (int) $match['id'],
            'score' => $score,
            'threshold' => $threshold,
            'finger' => $finger,
        ];
    }

    private function checkImage(string $imageBase64): string
    {
        $imageBase64 = trim($imageBase64);
        if ($imageBase64 === '') {
            throw new MatchingServiceRejected('The fingerprint image is empty.');
        }
        if (strlen($imageBase64) > self::MAX_IMAGE_CHARS) {
            throw new MatchingServiceRejected('The fingerprint image is too large.');
        }
        return $imageBase64;
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    private function post(string $path, array $body): array
    {
        if (!$this->isConfigured()) {
            throw new MatchingServiceUnavailable('Matching service is not configured.');
        }

        $encoded = json_encode($body, JSON_UNESCAPED_SLASHES);
        if ($encoded === false) {
            throw new MatchingServiceRejected('The fingerprint request could not be encoded.');
        }

        $handle = curl_init($this->baseUrl . $path);
        if ($handle === false) {
            throw new MatchingServiceUnavailable('Matching service is not running.');
        }

        curl_setopt_array($handle, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 2,
            CURLOPT_TIMEOUT => $this->timeoutSeconds,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'X-Matching-Key: ' . $this->key,
            ],
            CURLOPT_POSTFIELDS => $encoded,
        ]);

        $raw = curl_exec($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        $transportError = curl_error($handle);
        curl_close($handle);

        if ($raw === false || $status === 0) {
            // Details go to the server log only; the client gets a stable
            // message that never contains the key or the image.
            error_log('matching service unreachable: ' . ($transportError !== '' ? $transportError : 'no response'));
            throw new MatchingServiceUnavailable('Matching service is not running.');
        }

        $decoded = json_decode((string) $raw, true);
        if (!is_array($decoded)) {
            $decoded = [];
        }

        if ($status === 200) {
            return $decoded;
        }

        if (in_array($status, [400, 413, 415, 422], true)) {
            throw new MatchingServiceRejected('The fingerprint image could not be read.');
        }

        if ($status === 401 || $status === 403) {
            error_log('matching service rejected MATCHING_KEY (HTTP ' . $status . ')');
            throw new MatchingServiceUnavailable('The matching service rejected the configured key.');
        }

        error_log('matching service returned HTTP ' . $status);
        throw new MatchingServiceUnavailable('Matching service is not running.');
    }
}
