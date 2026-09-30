import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { ensurePlanAwareLoyaltySetup } from "../services/loyalty-installation.server";
import { getEmailNotificationSettings } from "../services/email-notifications.server";
import {
  DEFAULT_EMAIL_NOTIFICATION_SETTINGS,
  EMAIL_TEMPLATE_DEFINITIONS,
  EMAIL_TEMPLATE_FIELDS,
  EMAIL_TEMPLATE_PLACEHOLDERS,
  normalizeEmailTemplates,
} from "../services/email-notifications.shared";
import { logError } from "../services/errors.server";

function getSubmittedTemplates(formData) {
  return normalizeEmailTemplates(
    Object.fromEntries(
      EMAIL_TEMPLATE_DEFINITIONS.map(({ eventType }) => [
        eventType,
        Object.fromEntries(
          EMAIL_TEMPLATE_FIELDS.map(({ key }) => [
            key,
            formData.get(`emailTemplate_${eventType}_${key}`),
          ]),
        ),
      ]),
    ),
  );
}

function getTemplateValue(templates, template, fieldName) {
  const value = templates?.[template.eventType]?.[fieldName];

  return typeof value === "string" && value
    ? value
    : template.defaults[fieldName] || "";
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const { shop } = await ensurePlanAwareLoyaltySetup(session.shop, admin);
  const settings = await getEmailNotificationSettings(shop.id);

  return Response.json({ templates: settings.templates || {} });
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const templates = getSubmittedTemplates(formData);
  const { shop } = await ensurePlanAwareLoyaltySetup(session.shop, admin);

  try {
    await prisma.emailNotificationSetting.upsert({
      where: { shopId: shop.id },
      update: { templates },
      create: {
        shopId: shop.id,
        ...DEFAULT_EMAIL_NOTIFICATION_SETTINGS,
        templates,
      },
    });
  } catch (error) {
    logError("email-templates:save", error, { shop: session.shop });

    return Response.json(
      {
        error: "Could not save email templates. Please try again.",
        templates,
      },
      { status: 500 },
    );
  }

  return Response.json({ saved: true, templates });
};

export default function EmailTemplatesPage() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const templates = actionData?.templates || loaderData.templates;
  const isSaving = navigation.state === "submitting";

  return (
    <s-page heading="Email templates" inlineSize="large">
      <style>{emailTemplateStyles}</style>

      {actionData?.saved ? (
        <s-banner tone="success">Email templates saved successfully.</s-banner>
      ) : null}
      {actionData?.error ? (
        <s-banner tone="critical">{actionData.error}</s-banner>
      ) : null}

      <s-section>
        <s-stack gap="base">
          <s-text color="subdued">
            Customize every loyalty email. Fields are prefilled with their
            built-in values; clearing a field restores its default after saving.
          </s-text>

          <div className="email-template-placeholders">
            <span>Available placeholders:</span>
            {EMAIL_TEMPLATE_PLACEHOLDERS.map((placeholder) => (
              <code key={placeholder}>{`{{${placeholder}}}`}</code>
            ))}
          </div>

          <Form method="post">
            <div className="email-template-list">
              {EMAIL_TEMPLATE_DEFINITIONS.map((template) => (
                <details
                  className="email-template-editor"
                  key={template.eventType}
                >
                  <summary>
                    <span>
                      <strong>{template.label}</strong>
                      <small>{template.description}</small>
                    </span>
                    <span aria-hidden="true">Edit</span>
                  </summary>
                  <div className="email-template-fields">
                    {EMAIL_TEMPLATE_FIELDS.map((field) => {
                      const id = `emailTemplate_${template.eventType}_${field.key}`;
                      const commonProps = {
                        id,
                        name: id,
                        maxLength: field.maxLength,
                        defaultValue: getTemplateValue(
                          templates,
                          template,
                          field.key,
                        ),
                      };

                      return (
                        <div className="email-template-field" key={field.key}>
                          <label htmlFor={id}>{field.label}</label>
                          {field.multiline ? (
                            <textarea {...commonProps} rows={3} />
                          ) : (
                            <input {...commonProps} type="text" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </details>
              ))}
            </div>

            <div className="email-template-actions">
              <s-button href="/app/settings">Notification settings</s-button>
              <s-button
                type="submit"
                variant="primary"
                loading={isSaving || undefined}
              >
                Save templates
              </s-button>
            </div>
          </Form>
        </s-stack>
      </s-section>
    </s-page>
  );
}

const emailTemplateStyles = `
  .email-template-placeholders {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .email-template-placeholders span,
  .email-template-editor small {
    color: #616a75;
    font-size: 12px;
    line-height: 18px;
  }

  .email-template-placeholders code {
    background: #f7f8f8;
    border: 1px solid #dfe3e8;
    border-radius: 5px;
    color: #174ea6;
    font-size: 11px;
    padding: 3px 6px;
  }

  .email-template-list {
    display: grid;
    gap: 10px;
  }

  .email-template-editor {
    background: #ffffff;
    border: 1px solid #dfe3e8;
    border-radius: 8px;
  }

  .email-template-editor summary {
    align-items: center;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    padding: 14px;
  }

  .email-template-editor summary span:first-child,
  .email-template-editor summary strong,
  .email-template-editor summary small {
    display: block;
  }

  .email-template-editor summary > span:last-child {
    color: #005bd3;
    font-size: 12px;
    font-weight: 650;
  }

  .email-template-fields {
    border-top: 1px solid #e3e5e8;
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: 14px;
  }

  .email-template-field {
    display: grid;
    gap: 5px;
  }

  .email-template-field:has(textarea) {
    grid-column: 1 / -1;
  }

  .email-template-field label {
    color: #303030;
    font-size: 12px;
    font-weight: 650;
  }

  .email-template-field input,
  .email-template-field textarea {
    background: #ffffff;
    border: 1px solid #8c9196;
    border-radius: 7px;
    box-sizing: border-box;
    color: #202223;
    font: inherit;
    line-height: 20px;
    padding: 9px 10px;
    resize: vertical;
    width: 100%;
  }

  .email-template-field input:focus,
  .email-template-field textarea:focus {
    border-color: #005bd3;
    outline: 2px solid rgba(0, 91, 211, 0.2);
  }

  .email-template-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    margin-block-start: 16px;
  }

  @media (max-width: 700px) {
    .email-template-fields {
      grid-template-columns: 1fr;
    }

    .email-template-field:has(textarea) {
      grid-column: auto;
    }
  }
`;
