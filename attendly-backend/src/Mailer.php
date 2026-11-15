<?php
declare(strict_types=1);

namespace Attendly;

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\Exception;

require_once __DIR__ . '/PHPMailer/Exception.php';
require_once __DIR__ . '/PHPMailer/PHPMailer.php';
require_once __DIR__ . '/PHPMailer/SMTP.php';

final class Mailer
{
    public static function send(string $to, string $subject, string $htmlBody): bool
    {
        // Test addresses never leave the process: the API tests register
        // @example.test accounts and must not depend on real SMTP access.
        if (str_ends_with(strtolower($to), '@example.test')) {
            error_log("[mailer] skipped send to test recipient {$to}");
            return true;
        }

        $config = require __DIR__ . '/../config/config.php';
        
        $mail = new PHPMailer(true);

        try {
            // SMTP Configuration
            $mail->isSMTP();
            $mail->Host       = $config['smtp_host'] ?? 'smtp.gmail.com';
            $mail->SMTPAuth   = true;
            $mail->Username   = $config['smtp_user'] ?? '';
            $mail->Password   = $config['smtp_pass'] ?? '';
            $port             = (int) ($config['smtp_port'] ?? 587);
            $mail->Port       = $port;
            $mail->SMTPSecure = ($port === 465) ? PHPMailer::ENCRYPTION_SMTPS : PHPMailer::ENCRYPTION_STARTTLS;

            // Sender and Recipient
            $mail->setFrom($config['email_from'] ?? ($config['smtp_user'] ?? ''), 'ATTENDLY');
            $mail->addAddress($to);

            // Content
            $mail->isHTML(true);
            $mail->Subject = $subject;
            $mail->Body    = $htmlBody;
            $mail->AltBody = strip_tags($htmlBody);

            $mail->send();
            error_log("[mailer] SUCCESS: Email sent to {$to}");
            return true;
        } catch (Exception $e) {
            error_log("[PHPMailer Error] Message could not be sent. Mailer Error: {$mail->ErrorInfo}");
            return false;
        }
    }

    public static function sendOtpEmail(string $to, string $otp): bool
    {
        $safeOtp = htmlspecialchars($otp, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $html = '<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Verify your ATTENDLY account</title>
</head>
<body style="margin:0;padding:40px 16px;background:#f4f4f5;font-family:Arial,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:500px;background:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background:#1a4d3a;color:#ffffff;padding:24px 40px;text-align:center;font-size:24px;font-weight:700;letter-spacing:2px;">
              ATTENDLY
            </td>
          </tr>
          <tr>
            <td style="padding:40px;text-align:center;">
              <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#374151;">
                Hello! Use the verification code below to complete your registration.
              </p>
              <div style="margin:0 auto 24px;padding:18px 12px;background:#e6f7ef;border-radius:8px;color:#0e9f6e;font-size:32px;font-weight:700;letter-spacing:5px;line-height:1.2;">
                ' . $safeOtp . '
              </div>
              <p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280;">
                This code expires in 10 minutes.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>';

        return self::send($to, 'Your ATTENDLY verification code', $html);
    }

    public static function sendPasswordResetEmail(string $to, string $otp): bool
    {
        $safeOtp = htmlspecialchars($otp, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $html = '<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Reset your ATTENDLY password</title>
</head>
<body style="margin:0;padding:40px 16px;background:#f4f4f5;font-family:Arial,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:500px;background:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background:#1a4d3a;color:#ffffff;padding:24px 40px;text-align:center;font-size:24px;font-weight:700;letter-spacing:2px;">
              ATTENDLY
            </td>
          </tr>
          <tr>
            <td style="padding:40px;text-align:center;">
              <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#111827;">Password Reset Request</h2>
              <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#374151;">
                Hello! We received a request to reset your ATTENDLY password. Use the 6-digit code below to choose a new password.
              </p>
              <div style="margin:0 auto 24px;padding:18px 12px;background:#e6f7ef;border-radius:8px;color:#0e9f6e;font-size:32px;font-weight:700;letter-spacing:5px;line-height:1.2;">
                ' . $safeOtp . '
              </div>
              <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#6b7280;">
                This code expires in 60 minutes. If you did not request a password reset, you can safely ignore this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>';

        return self::send($to, 'Reset your ATTENDLY password', $html);
    }

    public static function sendAttendanceConfirmation(
        string $to,
        string $studentName,
        string $eventName,
        string $time,
        string $type
    ): bool {
        $safeName  = htmlspecialchars($studentName, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $safeEvent = htmlspecialchars($eventName, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $safeTime  = htmlspecialchars($time, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $safeType  = htmlspecialchars(ucwords(str_replace('_', ' ', $type)), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');

        $html = '<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Attendance Confirmation</title>
</head>
<body style="margin:0;padding:40px 16px;background:#f4f4f5;font-family:Arial,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:500px;background:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background:#1a4d3a;color:#ffffff;padding:24px 40px;text-align:center;font-size:24px;font-weight:700;letter-spacing:2px;">
              ATTENDLY
            </td>
          </tr>
          <tr>
            <td style="padding:40px;text-align:center;">
              <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#111827;">Attendance Recorded</h2>
              <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#374151;">
                Hello ' . $safeName . '! Your attendance has been successfully recorded.
              </p>
              <div style="margin:0 auto 24px;padding:20px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;text-align:left;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="6" border="0" style="font-size:14px;">
                  <tr>
                    <td style="color:#6b7280;width:35%;">Event:</td>
                    <td style="color:#111827;font-weight:600;">' . $safeEvent . '</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;">Action / Type:</td>
                    <td style="color:#111827;font-weight:600;">
                      <span style="display:inline-block;padding:2px 8px;background:#e6f7ef;color:#0e9f6e;border-radius:4px;font-size:12px;font-weight:700;">
                        ' . $safeType . '
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;">Timestamp:</td>
                    <td style="color:#111827;font-weight:600;">' . $safeTime . '</td>
                  </tr>
                </table>
              </div>
              <p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280;">
                You can review your complete attendance history anytime in your student dashboard.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>';

        return self::send($to, 'Attendance Confirmation: ' . $eventName, $html);
    }

    public static function sendSanctionWarning(
        string $to,
        string $studentName,
        $absenceCount
    ): bool {
        $safeName  = htmlspecialchars($studentName, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $safeCount = htmlspecialchars((string) $absenceCount, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');

        $html = '<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Attendance Sanction Warning</title>
</head>
<body style="margin:0;padding:40px 16px;background:#f4f4f5;font-family:Arial,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:500px;background:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background:#1a4d3a;color:#ffffff;padding:24px 40px;text-align:center;font-size:24px;font-weight:700;letter-spacing:2px;">
              ATTENDLY
            </td>
          </tr>
          <tr>
            <td style="padding:40px;text-align:center;">
              <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#991b1b;">Sanction Warning Notice</h2>
              <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#374151;">
                Hello ' . $safeName . ',
              </p>
              <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#374151;">
                You have <strong>' . $safeCount . ' unexcused absences</strong> recorded for mandatory campus events.
              </p>
              <div style="margin:0 auto 24px;padding:16px 20px;background:#fff1f2;border:1px solid #fecdd3;border-radius:8px;color:#9f1239;font-size:14px;line-height:1.5;text-align:left;">
                <strong>Notice:</strong> Accumulating more than 3 unexcused absences flags your account for disciplinary sanctions under SEASS attendance policies.
              </div>
              <p style="margin:0;font-size:14px;line-height:1.5;color:#6b7280;">
                Please log in to your ATTENDLY Student Portal to review your records. If you believe any absence was recorded in error, please submit an Attendance Correction Request with proof.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>';

        return self::send($to, 'ATTENDLY — Sanction Warning: ' . $safeCount . ' Unexcused Absences', $html);
    }
}
