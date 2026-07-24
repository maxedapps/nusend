import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const stackPath = join(root, "deploy/aws/nusend-stack.json");
const policyPath = join(root, "deploy/aws/policies/provisioning-policy.example.json");

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type CfnTemplate = {
  AWSTemplateFormatVersion?: string;
  Description?: string;
  Parameters?: Record<string, Record<string, Json>>;
  Conditions?: Record<string, Json>;
  Resources?: Record<string, CfnResource>;
  Outputs?: Record<string, Record<string, Json>>;
};

type CfnResource = {
  Type: string;
  Condition?: string;
  DependsOn?: string | string[];
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Properties?: Record<string, Json>;
};

type IamPolicyDocument = {
  Version?: string;
  Statement?: IamStatement[];
};

type IamStatement = {
  Sid?: string;
  Effect?: string;
  Action?: string | string[];
  Resource?: string | string[] | Json;
  Principal?: Json;
  Condition?: Record<string, Record<string, Json>>;
};

const BASE_EVENTS = ["BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY"] as const;
const REQUIRED_PARAMETERS = [
  "InstallationName",
  "SesDomainIdentity",
  "SesFromEmail",
  "PublicDomain",
  "EnableMarketing",
  "EnableTracking",
  "EnableDeliveryEvents",
  "Route53HostedZoneId",
  "AlertEmail",
  "EnableWebhookSubscription",
] as const;

const REQUIRED_CONDITIONS = [
  "CreateMarketing",
  "CreateTracking",
  "CreateDeliveryEvents",
  "CreateRoute53Dkim",
  "CreateWebhookSubscription",
] as const;

const REQUIRED_OUTPUTS = [
  "AwsRegion",
  "SesFromEmail",
  "TransactionalConfigurationSetName",
  "MarketingConfigurationSetName",
  "FeedbackTopicArn",
  "TrackingEvents",
  "RuntimeUserName",
  "DlqUrl",
  "DlqArn",
  "DlqName",
  "AlarmTopicArn",
  "DkimRecordName1",
  "DkimRecordValue1",
  "DkimRecordName2",
  "DkimRecordValue2",
  "DkimRecordName3",
  "DkimRecordValue3",
] as const;

const FORBIDDEN_RESOURCE_TYPES = [
  "AWS::IAM::AccessKey",
  "AWS::CloudFormation::CustomResource",
  "AWS::CloudFormation::Macro",
  "AWS::CloudFormation::Stack",
  "AWS::Lambda::Function",
  "AWS::Serverless::Function",
] as const;

const SECRET_OUTPUT_HINTS = [
  "secret",
  "password",
  "accesskey",
  "access_key",
  "private",
  "credential",
] as const;

const REQUIRED_PROVISIONING_ACTIONS = [
  "sts:GetCallerIdentity",
  "cloudformation:ValidateTemplate",
  "cloudformation:GetTemplateSummary",
  "cloudformation:CreateStack",
  "cloudformation:UpdateStack",
  "cloudformation:DeleteStack",
  "cloudformation:DescribeStacks",
  "cloudformation:DescribeStackEvents",
  "cloudformation:DescribeStackResource",
  "cloudformation:DescribeStackResources",
  "cloudformation:GetTemplate",
  "cloudformation:ListStackResources",
  "cloudformation:CreateChangeSet",
  "cloudformation:DescribeChangeSet",
  "cloudformation:ExecuteChangeSet",
  "cloudformation:DeleteChangeSet",
  "cloudformation:ListChangeSets",
  "cloudformation:DetectStackDrift",
  "cloudformation:DetectStackResourceDrift",
  "cloudformation:DescribeStackDriftDetectionStatus",
  "cloudformation:DescribeStackResourceDrifts",
  "cloudformation:ListStacks",
  "ses:CreateEmailIdentity",
  "ses:DeleteEmailIdentity",
  "ses:GetEmailIdentity",
  "ses:ListEmailIdentities",
  "ses:TagResource",
  "ses:UntagResource",
  "ses:CreateConfigurationSet",
  "ses:DeleteConfigurationSet",
  "ses:GetConfigurationSet",
  "ses:ListConfigurationSets",
  "ses:PutConfigurationSetSendingOptions",
  "ses:PutConfigurationSetSuppressionOptions",
  "ses:CreateConfigurationSetEventDestination",
  "ses:UpdateConfigurationSetEventDestination",
  "ses:DeleteConfigurationSetEventDestination",
  "ses:GetConfigurationSetEventDestinations",
  "ses:GetAccount",
  "ses:PutAccountDetails",
  "sns:CreateTopic",
  "sns:DeleteTopic",
  "sns:GetTopicAttributes",
  "sns:SetTopicAttributes",
  "sns:TagResource",
  "sns:UntagResource",
  "sns:Subscribe",
  "sns:Unsubscribe",
  "sns:GetSubscriptionAttributes",
  "sns:SetSubscriptionAttributes",
  "sns:ListSubscriptionsByTopic",
  "sqs:CreateQueue",
  "sqs:DeleteQueue",
  "sqs:GetQueueUrl",
  "sqs:GetQueueAttributes",
  "sqs:SetQueueAttributes",
  "sqs:TagQueue",
  "sqs:UntagQueue",
  "iam:CreateUser",
  "iam:DeleteUser",
  "iam:GetUser",
  "iam:TagUser",
  "iam:PutUserPolicy",
  "iam:GetUserPolicy",
  "iam:DeleteUserPolicy",
  "iam:ListUserPolicies",
  "iam:ListUserTags",
  "iam:ListAttachedUserPolicies",
  "iam:ListGroupsForUser",
  "iam:ListSigningCertificates",
  "iam:ListSSHPublicKeys",
  "iam:GetLoginProfile",
  "iam:ListAccessKeys",
  "iam:CreateAccessKey",
  "iam:DeleteAccessKey",
  "cloudwatch:PutMetricAlarm",
  "cloudwatch:DeleteAlarms",
  "cloudwatch:DescribeAlarms",
  "cloudwatch:TagResource",
  "cloudwatch:UntagResource",
  "cloudwatch:ListTagsForResource",
  "route53:GetHostedZone",
  "route53:ChangeResourceRecordSets",
  "route53:ListResourceRecordSets",
] as const;

const FORBIDDEN_PROVISIONING_ACTIONS = [
  "ses:PutAccountSuppressionAttributes",
  "iam:AttachUserPolicy",
  "iam:DetachUserPolicy",
  "iam:AttachRolePolicy",
  "iam:DetachRolePolicy",
  "iam:AttachGroupPolicy",
  "iam:PutRolePolicy",
  "iam:PassRole",
  "iam:CreateLoginProfile",
  "iam:UpdateLoginProfile",
  "iam:DeleteLoginProfile",
  "iam:AddUserToGroup",
  "iam:RemoveUserFromGroup",
  "iam:CreatePolicy",
  "iam:CreatePolicyVersion",
  "iam:CreateGroup",
  "iam:CreateRole",
  "secretsmanager:CreateSecret",
  "secretsmanager:DeleteSecret",
  "secretsmanager:GetSecretValue",
  "secretsmanager:PutSecretValue",
  "ssm:DeleteParameter",
  "ssm:PutParameter",
  "ssm:GetParameter",
  "kms:ScheduleKeyDeletion",
  "kms:DeleteAlias",
  "kms:DisableKey",
  "kms:PutKeyPolicy",
] as const;

function loadJson(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

function asRecord(value: Json | undefined): Record<string, Json> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object.");
  }
  return value;
}

function asResourceMap(template: CfnTemplate): Record<string, CfnResource> {
  if (!template.Resources || typeof template.Resources !== "object") {
    throw new Error("Template missing Resources.");
  }
  return template.Resources;
}

function resource(template: CfnTemplate, logicalId: string): CfnResource {
  const found = asResourceMap(template)[logicalId];
  if (!found) {
    throw new Error(`Missing resource ${logicalId}`);
  }
  return found;
}

function props(template: CfnTemplate, logicalId: string): Record<string, Json> {
  const properties = resource(template, logicalId).Properties;
  if (!properties) {
    throw new Error(`Resource ${logicalId} missing Properties`);
  }
  return properties;
}

function actionsOf(statement: IamStatement): string[] {
  if (typeof statement.Action === "string") return [statement.Action];
  if (Array.isArray(statement.Action)) {
    return statement.Action.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function flattenActions(document: IamPolicyDocument): string[] {
  const statements = document.Statement ?? [];
  return statements.flatMap((statement) => actionsOf(statement));
}

function collectStrings(value: Json, into = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    into.add(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
    return into;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) collectStrings(nested, into);
  }
  return into;
}

function findFnIf(value: Json, conditionName: string): { then: Json; else: Json } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, Json>;
  const fnIf = record["Fn::If"];
  if (Array.isArray(fnIf) && fnIf[0] === conditionName && fnIf.length === 3) {
    return { then: fnIf[1] as Json, else: fnIf[2] as Json };
  }
  for (const nested of Object.values(record)) {
    const found = findFnIf(nested, conditionName);
    if (found) return found;
  }
  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findFnIf(nested, conditionName);
      if (found) return found;
    }
  }
  return null;
}

function findAllFnIf(
  value: Json,
  conditionName: string,
  into: Array<{ then: Json; else: Json }> = [],
) {
  if (Array.isArray(value)) {
    for (const nested of value) findAllFnIf(nested, conditionName, into);
    return into;
  }
  if (!value || typeof value !== "object") return into;
  const record = value as Record<string, Json>;
  const fnIf = record["Fn::If"];
  if (Array.isArray(fnIf) && fnIf[0] === conditionName && fnIf.length === 3) {
    into.push({ then: fnIf[1] as Json, else: fnIf[2] as Json });
  }
  for (const nested of Object.values(record)) findAllFnIf(nested, conditionName, into);
  return into;
}

function managedTags(properties: Record<string, Json>) {
  expect(properties.Tags).toEqual(
    expect.arrayContaining([
      { Key: "nusend:managed-by", Value: "cloudformation" },
      {
        Key: "nusend:installation",
        Value: { Ref: "InstallationName" },
      },
    ]),
  );
}

function runtimePolicyDocument(template: CfnTemplate): IamPolicyDocument {
  const policies = props(template, "RuntimeUser").Policies;
  expect(Array.isArray(policies)).toBe(true);
  const first = (policies as Json[])[0];
  const policy = asRecord(first);
  expect(policy.PolicyName).toBe("nusend-runtime");
  return asRecord(policy.PolicyDocument) as IamPolicyDocument;
}

function statementBySid(document: IamPolicyDocument, sid: string): IamStatement {
  const found = (document.Statement ?? []).find((statement) => statement.Sid === sid);
  if (!found) throw new Error(`Missing statement ${sid}`);
  return found;
}

describe("nusend CloudFormation stack", () => {
  const raw = readFileSync(stackPath, "utf8");
  const template = loadJson(stackPath) as CfnTemplate;

  it("is static directly parseable JSON without generators", () => {
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(template.AWSTemplateFormatVersion).toBe("2010-09-09");
    expect(template.Description).toMatch(/CAPABILITY_NAMED_IAM/);
    expect(raw.includes("Fn::Transform")).toBe(false);
    expect(raw.toLowerCase().includes("aws::serverless")).toBe(false);
  });

  it("declares installation, SES, public domain, marketing/tracking/delivery, Route53, alert, and webhook parameters", () => {
    const parameters = template.Parameters ?? {};
    for (const name of REQUIRED_PARAMETERS) {
      expect(parameters[name]).toBeTruthy();
    }

    for (const flag of [
      "EnableMarketing",
      "EnableTracking",
      "EnableDeliveryEvents",
      "EnableWebhookSubscription",
    ] as const) {
      expect(parameters[flag]?.AllowedValues).toEqual(["true", "false"]);
    }

    expect(parameters.EnableWebhookSubscription?.Default).toBe("false");
    expect(parameters.Route53HostedZoneId?.Default).toBe("");
    expect(parameters.InstallationName?.AllowedPattern).toBe("^[a-z][a-z0-9-]{0,30}$");
  });

  it("exposes conditions for marketing, tracking, delivery, Route53, and webhook finalize variants", () => {
    const conditions = template.Conditions ?? {};
    for (const name of REQUIRED_CONDITIONS) {
      expect(conditions[name]).toBeTruthy();
    }

    expect(conditions.CreateMarketing).toEqual({
      "Fn::Equals": [{ Ref: "EnableMarketing" }, "true"],
    });
    expect(conditions.CreateWebhookSubscription).toEqual({
      "Fn::Equals": [{ Ref: "EnableWebhookSubscription" }, "true"],
    });
    expect(conditions.CreateRoute53Dkim).toEqual({
      "Fn::Not": [{ "Fn::Equals": [{ Ref: "Route53HostedZoneId" }, ""] }],
    });
    expect(asRecord(conditions.CreateTracking)["Fn::And"]).toEqual(
      expect.arrayContaining([
        { Condition: "CreateMarketing" },
        { "Fn::Equals": [{ Ref: "EnableTracking" }, "true"] },
      ]),
    );
  });

  it("creates tagged SES domain identity and optional Route 53 Easy DKIM CNAMEs", () => {
    const identity = resource(template, "EmailIdentity");
    expect(identity.Type).toBe("AWS::SES::EmailIdentity");
    expect(props(template, "EmailIdentity").EmailIdentity).toEqual({
      Ref: "SesDomainIdentity",
    });
    managedTags(props(template, "EmailIdentity"));

    for (const [logicalId, token] of [
      ["DkimRecord1", "1"],
      ["DkimRecord2", "2"],
      ["DkimRecord3", "3"],
    ] as const) {
      const record = resource(template, logicalId);
      expect(record.Type).toBe("AWS::Route53::RecordSet");
      expect(record.Condition).toBe("CreateRoute53Dkim");
      const recordProps = props(template, logicalId);
      expect(recordProps.HostedZoneId).toEqual({ Ref: "Route53HostedZoneId" });
      expect(recordProps.Type).toBe("CNAME");
      expect(recordProps.TTL).toBe("300");
      expect(recordProps.Name).toEqual({
        "Fn::GetAtt": ["EmailIdentity", `DkimDNSTokenName${token}`],
      });
      expect(recordProps.ResourceRecords).toEqual([
        { "Fn::GetAtt": ["EmailIdentity", `DkimDNSTokenValue${token}`] },
      ]);
    }
  });

  it("creates transactional and conditional marketing configuration sets with sending and BOUNCE+COMPLAINT suppression", () => {
    for (const logicalId of [
      "TransactionalConfigurationSet",
      "MarketingConfigurationSet",
    ] as const) {
      const configurationSet = resource(template, logicalId);
      expect(configurationSet.Type).toBe("AWS::SES::ConfigurationSet");
      const configurationProps = props(template, logicalId);
      expect(configurationProps.SendingOptions).toEqual({ SendingEnabled: true });
      expect(configurationProps.SuppressionOptions).toEqual({
        SuppressedReasons: ["BOUNCE", "COMPLAINT"],
      });
      managedTags(configurationProps);
    }

    expect(resource(template, "MarketingConfigurationSet").Condition).toBe("CreateMarketing");
    expect(props(template, "TransactionalConfigurationSet").Name).toEqual({
      "Fn::Sub": "nusend-${InstallationName}-transactional",
    });
    expect(props(template, "MarketingConfigurationSet").Name).toEqual({
      "Fn::Sub": "nusend-${InstallationName}-marketing",
    });
  });

  it("creates SignatureVersion 2 feedback topic with SES source-account and exact configuration-set ARN restrictions", () => {
    const topic = resource(template, "FeedbackTopic");
    expect(topic.Type).toBe("AWS::SNS::Topic");
    expect(props(template, "FeedbackTopic").SignatureVersion).toBe("2");
    expect(props(template, "FeedbackTopic").TopicName).toEqual({
      "Fn::Sub": "nusend-${InstallationName}-ses-events",
    });
    managedTags(props(template, "FeedbackTopic"));

    const policy = resource(template, "FeedbackTopicPolicy");
    expect(policy.Type).toBe("AWS::SNS::TopicPolicy");
    const document = asRecord(props(template, "FeedbackTopicPolicy").PolicyDocument);
    const statements = document.Statement as IamStatement[];
    expect(statements).toHaveLength(1);
    const statement = statements[0]!;
    expect(statement.Sid).toBe("AllowSesConfigurationSets");
    expect(statement.Effect).toBe("Allow");
    expect(statement.Principal).toEqual({ Service: "ses.amazonaws.com" });
    expect(statement.Action).toBe("sns:Publish");
    expect(statement.Resource).toEqual({ Ref: "FeedbackTopic" });
    expect(statement.Condition?.StringEquals?.["aws:SourceAccount"]).toEqual({
      Ref: "AWS::AccountId",
    });

    const sourceArn = statement.Condition?.ArnEquals?.["aws:SourceArn"];
    const marketingBranch = findFnIf(sourceArn as Json, "CreateMarketing");
    expect(marketingBranch).toBeTruthy();
    const thenStrings = [...collectStrings(marketingBranch!.then)].join("\n");
    const elseStrings = [...collectStrings(marketingBranch!.else)].join("\n");
    expect(thenStrings).toContain("configuration-set/nusend-${InstallationName}-transactional");
    expect(thenStrings).toContain("configuration-set/nusend-${InstallationName}-marketing");
    expect(elseStrings).toContain("configuration-set/nusend-${InstallationName}-transactional");
    expect(elseStrings).not.toContain("configuration-set/nusend-${InstallationName}-marketing");
  });

  it("wires SES event destinations with base events, conditional DELIVERY, and marketing OPEN/CLICK", () => {
    const transactional = resource(template, "TransactionalEventDestination");
    expect(transactional.Type).toBe("AWS::SES::ConfigurationSetEventDestination");
    const transactionalDestination = asRecord(
      props(template, "TransactionalEventDestination").EventDestination,
    );
    expect(transactionalDestination.Name).toBe("nusend-sns");
    expect(transactionalDestination.Enabled).toBe(true);
    expect(transactionalDestination.SnsDestination).toEqual({
      TopicARN: { Ref: "FeedbackTopic" },
    });

    const transactionalEvents = findFnIf(
      transactionalDestination.MatchingEventTypes,
      "CreateDeliveryEvents",
    );
    expect(transactionalEvents).toBeTruthy();
    expect(transactionalEvents!.then).toEqual([...BASE_EVENTS, "DELIVERY"]);
    expect(transactionalEvents!.else).toEqual([...BASE_EVENTS]);

    const marketing = resource(template, "MarketingEventDestination");
    expect(marketing.Condition).toBe("CreateMarketing");
    const marketingDestination = asRecord(
      props(template, "MarketingEventDestination").EventDestination,
    );
    expect(marketingDestination.SnsDestination).toEqual({
      TopicARN: { Ref: "FeedbackTopic" },
    });

    const trackingBranch = findFnIf(marketingDestination.MatchingEventTypes, "CreateTracking");
    expect(trackingBranch).toBeTruthy();
    const trackingWithDelivery = findFnIf(trackingBranch!.then, "CreateDeliveryEvents");
    expect(trackingWithDelivery).toBeTruthy();
    expect(trackingWithDelivery!.then).toEqual([...BASE_EVENTS, "DELIVERY", "OPEN", "CLICK"]);
    expect(trackingWithDelivery!.else).toEqual([...BASE_EVENTS, "OPEN", "CLICK"]);

    const noTrackingWithDelivery = findFnIf(trackingBranch!.else, "CreateDeliveryEvents");
    expect(noTrackingWithDelivery).toBeTruthy();
    expect(noTrackingWithDelivery!.then).toEqual([...BASE_EVENTS, "DELIVERY"]);
    expect(noTrackingWithDelivery!.else).toEqual([...BASE_EVENTS]);
  });

  it("creates an encrypted 14-day SQS DLQ with SNS source-account and topic ARN queue policy", () => {
    const queue = resource(template, "WebhookDlq");
    expect(queue.Type).toBe("AWS::SQS::Queue");
    const queueProps = props(template, "WebhookDlq");
    expect(queueProps.QueueName).toEqual({
      "Fn::Sub": "nusend-${InstallationName}-ses-webhook-dlq",
    });
    expect(queueProps.MessageRetentionPeriod).toBe(1209600);
    expect(queueProps.SqsManagedSseEnabled).toBe(true);
    managedTags(queueProps);

    const policy = resource(template, "WebhookDlqPolicy");
    expect(policy.Type).toBe("AWS::SQS::QueuePolicy");
    const document = asRecord(props(template, "WebhookDlqPolicy").PolicyDocument);
    const statement = (document.Statement as IamStatement[])[0]!;
    expect(statement.Sid).toBe("AllowSnsSubscriptionRedrive");
    expect(statement.Principal).toEqual({ Service: "sns.amazonaws.com" });
    expect(statement.Action).toBe("sqs:SendMessage");
    expect(statement.Resource).toEqual({ "Fn::GetAtt": ["WebhookDlq", "Arn"] });
    expect(statement.Condition?.StringEquals?.["aws:SourceAccount"]).toEqual({
      Ref: "AWS::AccountId",
    });
    expect(statement.Condition?.ArnEquals?.["aws:SourceArn"]).toEqual({
      Ref: "FeedbackTopic",
    });
  });

  it("creates a named runtime IAM user with least-privilege inline policy and FromAddress condition", () => {
    const user = resource(template, "RuntimeUser");
    expect(user.Type).toBe("AWS::IAM::User");
    expect(props(template, "RuntimeUser").UserName).toEqual({
      "Fn::Sub": "nusend-${InstallationName}-runtime",
    });
    managedTags(props(template, "RuntimeUser"));

    const document = runtimePolicyDocument(template);
    const sids = (document.Statement ?? []).map((statement) => statement.Sid);
    expect(sids).toEqual([
      "ReadSesAccount",
      "ReadSesIdentities",
      "ReadSesConfigurationSets",
      "SendOnlyFromNusend",
      "ReadFeedbackTopic",
    ]);

    expect(statementBySid(document, "ReadSesAccount").Action).toBe("ses:GetAccount");
    expect(statementBySid(document, "ReadSesAccount").Resource).toBe("*");

    const identities = statementBySid(document, "ReadSesIdentities");
    expect(identities.Action).toBe("ses:GetEmailIdentity");
    const identityResources = [...collectStrings(identities.Resource as Json)].join("\n");
    expect(identityResources).toContain("identity/${SesFromEmail}");
    expect(identityResources).toContain("identity/${SesDomainIdentity}");

    const configSets = statementBySid(document, "ReadSesConfigurationSets");
    expect(configSets.Action).toEqual([
      "ses:GetConfigurationSet",
      "ses:GetConfigurationSetEventDestinations",
    ]);
    const configSetBranch = findFnIf(configSets.Resource as Json, "CreateMarketing");
    expect(configSetBranch).toBeTruthy();
    expect([...collectStrings(configSetBranch!.then)].join("\n")).toContain(
      "configuration-set/nusend-${InstallationName}-marketing",
    );
    expect([...collectStrings(configSetBranch!.else)].join("\n")).not.toContain(
      "configuration-set/nusend-${InstallationName}-marketing",
    );

    const send = statementBySid(document, "SendOnlyFromNusend");
    expect(send.Action).toBe("ses:SendEmail");
    expect(send.Condition?.StringEquals?.["ses:FromAddress"]).toEqual({
      Ref: "SesFromEmail",
    });
    const sendBranch = findFnIf(send.Resource as Json, "CreateMarketing");
    expect(sendBranch).toBeTruthy();
    const sendThen = [...collectStrings(sendBranch!.then)].join("\n");
    expect(sendThen).toContain("identity/${SesFromEmail}");
    expect(sendThen).toContain("identity/${SesDomainIdentity}");
    expect(sendThen).toContain("configuration-set/nusend-${InstallationName}-transactional");
    expect(sendThen).toContain("configuration-set/nusend-${InstallationName}-marketing");

    const topic = statementBySid(document, "ReadFeedbackTopic");
    expect(topic.Action).toEqual(["sns:GetTopicAttributes", "sns:ListSubscriptionsByTopic"]);
    expect(topic.Resource).toEqual({ Ref: "FeedbackTopic" });
  });

  it("creates a dedicated alarm topic, email subscription, and the four exact CloudWatch alarms", () => {
    expect(resource(template, "AlarmTopic").Type).toBe("AWS::SNS::Topic");
    expect(props(template, "AlarmTopic").TopicName).toEqual({
      "Fn::Sub": "nusend-${InstallationName}-ops-alarms",
    });
    managedTags(props(template, "AlarmTopic"));

    const emailSubscription = resource(template, "AlarmEmailSubscription");
    expect(emailSubscription.Type).toBe("AWS::SNS::Subscription");
    expect(props(template, "AlarmEmailSubscription")).toMatchObject({
      Protocol: "email",
      Endpoint: { Ref: "AlertEmail" },
      TopicArn: { Ref: "AlarmTopic" },
    });

    const expectedAlarms = [
      {
        id: "AlarmSnsNotificationsFailed",
        name: "nusend-${InstallationName}-sns-notifications-failed",
        metric: "NumberOfNotificationsFailed",
        namespace: "AWS/SNS",
        statistic: "Sum",
        dimensionName: "TopicName",
        dimensionValue: "nusend-${InstallationName}-ses-events",
      },
      {
        id: "AlarmSnsRedrivenToDlq",
        name: "nusend-${InstallationName}-sns-redriven-to-dlq",
        metric: "NumberOfNotificationsRedrivenToDlq",
        namespace: "AWS/SNS",
        statistic: "Sum",
        dimensionName: "TopicName",
        dimensionValue: "nusend-${InstallationName}-ses-events",
      },
      {
        id: "AlarmSnsRedriveFailed",
        name: "nusend-${InstallationName}-sns-redrive-failed",
        metric: "NumberOfNotificationsFailedToRedriveToDlq",
        namespace: "AWS/SNS",
        statistic: "Sum",
        dimensionName: "TopicName",
        dimensionValue: "nusend-${InstallationName}-ses-events",
      },
      {
        id: "AlarmDlqVisibleMessages",
        name: "nusend-${InstallationName}-dlq-visible-messages",
        metric: "ApproximateNumberOfMessagesVisible",
        namespace: "AWS/SQS",
        statistic: "Maximum",
        dimensionName: "QueueName",
        dimensionValue: "nusend-${InstallationName}-ses-webhook-dlq",
      },
    ] as const;

    for (const alarm of expectedAlarms) {
      const alarmResource = resource(template, alarm.id);
      expect(alarmResource.Type).toBe("AWS::CloudWatch::Alarm");
      const alarmProps = props(template, alarm.id);
      expect(alarmProps.AlarmName).toEqual({ "Fn::Sub": alarm.name });
      expect(alarmProps.Namespace).toBe(alarm.namespace);
      expect(alarmProps.MetricName).toBe(alarm.metric);
      expect(alarmProps.Statistic).toBe(alarm.statistic);
      expect(alarmProps.Period).toBe(300);
      expect(alarmProps.EvaluationPeriods).toBe(1);
      expect(alarmProps.DatapointsToAlarm).toBe(1);
      expect(alarmProps.Threshold).toBe(0);
      expect(alarmProps.ComparisonOperator).toBe("GreaterThanThreshold");
      expect(alarmProps.TreatMissingData).toBe("notBreaching");
      expect(alarmProps.AlarmActions).toEqual([{ Ref: "AlarmTopic" }]);
      expect(alarmProps.Dimensions).toEqual([
        {
          Name: alarm.dimensionName,
          Value: { "Fn::Sub": alarm.dimensionValue },
        },
      ]);
      managedTags(alarmProps);
    }
  });

  it("creates the conditional HTTPS webhook subscription with exact path, raw false, and DLQ redrive", () => {
    const subscription = resource(template, "WebhookSubscription");
    expect(subscription.Type).toBe("AWS::SNS::Subscription");
    expect(subscription.Condition).toBe("CreateWebhookSubscription");
    expect(subscription.DependsOn).toEqual(["WebhookDlqPolicy"]);
    const subscriptionProps = props(template, "WebhookSubscription");
    expect(subscriptionProps.Protocol).toBe("https");
    expect(subscriptionProps.Endpoint).toEqual({
      "Fn::Sub": "https://${PublicDomain}/api/webhooks/aws/sns/ses",
    });
    expect(subscriptionProps.TopicArn).toEqual({ Ref: "FeedbackTopic" });
    expect(subscriptionProps.RawMessageDelivery).toBe(false);
    expect(subscriptionProps.RedrivePolicy).toEqual({
      deadLetterTargetArn: { "Fn::GetAtt": ["WebhookDlq", "Arn"] },
    });
  });

  it("joins event destinations and webhook subscription on required DependsOn edges", () => {
    expect(resource(template, "TransactionalEventDestination").DependsOn).toEqual([
      "FeedbackTopicPolicy",
    ]);
    expect(resource(template, "MarketingEventDestination").DependsOn).toEqual([
      "FeedbackTopicPolicy",
    ]);
    expect(resource(template, "WebhookSubscription").DependsOn).toEqual(["WebhookDlqPolicy"]);
  });

  it("outputs only required non-secrets including six DKIM records and conditional marketing/tracking values", () => {
    const outputs = template.Outputs ?? {};
    for (const name of REQUIRED_OUTPUTS) {
      expect(outputs[name]).toBeTruthy();
      expect(outputs[name]?.Value).toBeTruthy();
    }

    expect(outputs.AwsRegion?.Value).toEqual({ Ref: "AWS::Region" });
    expect(outputs.SesFromEmail?.Value).toEqual({ Ref: "SesFromEmail" });
    expect(outputs.FeedbackTopicArn?.Value).toEqual({ Ref: "FeedbackTopic" });
    expect(outputs.RuntimeUserName?.Value).toEqual({ Ref: "RuntimeUser" });
    expect(outputs.DlqUrl?.Value).toEqual({ Ref: "WebhookDlq" });
    expect(outputs.DlqArn?.Value).toEqual({ "Fn::GetAtt": ["WebhookDlq", "Arn"] });
    expect(outputs.AlarmTopicArn?.Value).toEqual({ Ref: "AlarmTopic" });

    const marketingOutput = findFnIf(
      outputs.MarketingConfigurationSetName?.Value as Json,
      "CreateMarketing",
    );
    expect(marketingOutput).toEqual({
      then: { Ref: "MarketingConfigurationSet" },
      else: "",
    });

    const trackingOutput = findFnIf(outputs.TrackingEvents?.Value as Json, "CreateTracking");
    expect(trackingOutput).toEqual({
      then: "open,click",
      else: "",
    });

    for (const index of ["1", "2", "3"] as const) {
      expect(outputs[`DkimRecordName${index}`]?.Value).toEqual({
        "Fn::GetAtt": ["EmailIdentity", `DkimDNSTokenName${index}`],
      });
      expect(outputs[`DkimRecordValue${index}`]?.Value).toEqual({
        "Fn::GetAtt": ["EmailIdentity", `DkimDNSTokenValue${index}`],
      });
    }

    for (const [name, output] of Object.entries(outputs)) {
      const blob = JSON.stringify(output).toLowerCase();
      for (const hint of SECRET_OUTPUT_HINTS) {
        expect(blob.includes(hint), `${name} must not look secret (${hint})`).toBe(false);
      }
    }
  });

  it("forbids access keys, retain policies, nested stacks, macros, custom resources, and secret resources", () => {
    const resources = asResourceMap(template);
    for (const [logicalId, entry] of Object.entries(resources)) {
      expect(
        FORBIDDEN_RESOURCE_TYPES.includes(entry.Type as (typeof FORBIDDEN_RESOURCE_TYPES)[number]),
      ).toBe(false);
      expect(entry.DeletionPolicy, logicalId).toBeUndefined();
      expect(entry.UpdateReplacePolicy, logicalId).toBeUndefined();
      expect(entry.Type.startsWith("Custom::"), logicalId).toBe(false);
    }

    expect(Object.values(resources).some((entry) => entry.Type === "AWS::IAM::User")).toBe(true);
    expect(Object.values(resources).some((entry) => entry.Type === "AWS::IAM::AccessKey")).toBe(
      false,
    );
  });

  it("keeps core webhook disabled by default while finalize/marketing/tracking/delivery/R53 remain condition-driven", () => {
    expect(template.Parameters?.EnableWebhookSubscription?.Default).toBe("false");
    expect(resource(template, "WebhookSubscription").Condition).toBe("CreateWebhookSubscription");
    expect(resource(template, "MarketingConfigurationSet").Condition).toBe("CreateMarketing");
    expect(resource(template, "MarketingEventDestination").Condition).toBe("CreateMarketing");
    expect(resource(template, "DkimRecord1").Condition).toBe("CreateRoute53Dkim");

    const deliveryBranches = findAllFnIf(
      props(template, "TransactionalEventDestination").EventDestination as Json,
      "CreateDeliveryEvents",
    );
    expect(deliveryBranches.length).toBeGreaterThan(0);

    const trackingBranches = findAllFnIf(
      props(template, "MarketingEventDestination").EventDestination as Json,
      "CreateTracking",
    );
    expect(trackingBranches.length).toBeGreaterThan(0);
  });
});

describe("temporary provisioning policy example", () => {
  const raw = readFileSync(policyPath, "utf8");
  const document = loadJson(policyPath) as IamPolicyDocument;

  it("is parseable IAM policy JSON with allow statements only", () => {
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(document.Version).toBe("2012-10-17");
    expect(Array.isArray(document.Statement)).toBe(true);
    expect(document.Statement!.length).toBeGreaterThan(0);
    for (const statement of document.Statement ?? []) {
      expect(statement.Effect).toBe("Allow");
    }
  });

  it("includes the exact required coordinator and stack lifecycle actions", () => {
    const actions = new Set(flattenActions(document));
    for (const action of REQUIRED_PROVISIONING_ACTIONS) {
      expect(actions.has(action), `missing required action ${action}`).toBe(true);
    }
  });

  it("locks the forbidden boundary for account suppression, broad IAM, secrets, SSM, and KMS destruction", () => {
    const actions = new Set(flattenActions(document));

    // Access-key create/delete remain allowed only on the scoped runtime user statement.
    const accessKeyStatements = (document.Statement ?? []).filter((statement) =>
      actionsOf(statement).some(
        (action) => action === "iam:CreateAccessKey" || action === "iam:DeleteAccessKey",
      ),
    );
    expect(accessKeyStatements.length).toBeGreaterThan(0);
    for (const statement of accessKeyStatements) {
      expect(statement.Resource).toBe("arn:aws:iam::123456789012:user/nusend-demo-runtime");
      expect(statement.Resource === "*").toBe(false);
    }

    for (const action of FORBIDDEN_PROVISIONING_ACTIONS) {
      expect(actions.has(action), `forbidden action present: ${action}`).toBe(false);
    }

    const joined = flattenActions(document).join("\n");
    expect(joined.includes("secretsmanager:")).toBe(false);
    expect(joined.includes("ssm:")).toBe(false);
    expect(joined.includes("kms:")).toBe(false);
    expect(joined.includes("iam:PassRole")).toBe(false);
    expect(joined.includes("iam:AttachUserPolicy")).toBe(false);
    expect(joined.includes("iam:CreateLoginProfile")).toBe(false);
    expect(joined.includes("ses:PutAccountSuppressionAttributes")).toBe(false);
  });

  it("uses placeholder account/region/stack/installation/zone resource scopes", () => {
    const blob = JSON.stringify(document);
    expect(blob).toContain("123456789012");
    expect(blob).toContain("us-east-1");
    expect(blob).toContain("nusend-demo");
    expect(blob).toContain("Z1234567890ABC");
    expect(blob).toContain("nusend-demo-runtime");
    expect(blob).toContain("stack/nusend-demo/*");
  });

  it("renders explicit GovCloud partition/region/account/installation/zone substitutions as constrained JSON", () => {
    const renderedRaw = raw
      .replaceAll("arn:aws:", "arn:aws-us-gov:")
      .replaceAll("us-east-1", "us-gov-west-1")
      .replaceAll("123456789012", "210987654321")
      .replaceAll("nusend-demo", "nusend-federal")
      .replaceAll("Z1234567890ABC", "Z0GOVCLOUD12345");
    const rendered = JSON.parse(renderedRaw) as IamPolicyDocument;
    const blob = JSON.stringify(rendered);

    expect(blob).not.toMatch(/arn:aws:|us-east-1|123456789012|nusend-demo|Z1234567890ABC/u);
    expect(blob).toContain(
      "arn:aws-us-gov:cloudformation:us-gov-west-1:210987654321:stack/nusend-federal/*",
    );
    expect(blob).toContain("arn:aws-us-gov:iam::210987654321:user/nusend-federal-runtime");
    expect(blob).toContain("arn:aws-us-gov:route53:::hostedzone/Z0GOVCLOUD12345");

    const originalResources = (document.Statement ?? []).map((statement) => statement.Resource);
    expect((rendered.Statement ?? []).map((statement) => statement.Resource)).toHaveLength(
      originalResources.length,
    );
    for (const statement of rendered.Statement ?? []) {
      const resources = Array.isArray(statement.Resource)
        ? statement.Resource
        : [statement.Resource];
      for (const resourceArn of resources) {
        if (resourceArn === "*" || resourceArn === undefined) continue;
        expect(resourceArn).toMatch(/^arn:aws-us-gov:/u);
      }
    }
  });

  it("scopes IAM user teardown inspection actions to the runtime user only", () => {
    const iamStatement = (document.Statement ?? []).find(
      (statement) => statement.Sid === "ManageRuntimeIamUserAndAccessKeys",
    );
    expect(iamStatement).toBeTruthy();
    const actions = new Set(actionsOf(iamStatement!));
    for (const action of [
      "iam:ListUserPolicies",
      "iam:ListUserTags",
      "iam:ListAttachedUserPolicies",
      "iam:ListGroupsForUser",
      "iam:ListSigningCertificates",
      "iam:ListSSHPublicKeys",
      "iam:GetLoginProfile",
    ] as const) {
      expect(actions.has(action), `missing IAM teardown action ${action}`).toBe(true);
    }
    expect(iamStatement!.Resource).toBe("arn:aws:iam::123456789012:user/nusend-demo-runtime");
  });

  it("scopes CloudWatch alarm tag actions to the four exact alarm ARNs", () => {
    const alarmStatement = (document.Statement ?? []).find(
      (statement) => statement.Sid === "ManageCloudWatchAlarms",
    );
    expect(alarmStatement).toBeTruthy();
    const actions = new Set(actionsOf(alarmStatement!));
    for (const action of [
      "cloudwatch:TagResource",
      "cloudwatch:UntagResource",
      "cloudwatch:ListTagsForResource",
    ] as const) {
      expect(actions.has(action), `missing CloudWatch tag action ${action}`).toBe(true);
    }
    expect(alarmStatement!.Resource).toEqual([
      "arn:aws:cloudwatch:us-east-1:123456789012:alarm:nusend-demo-sns-notifications-failed",
      "arn:aws:cloudwatch:us-east-1:123456789012:alarm:nusend-demo-sns-redriven-to-dlq",
      "arn:aws:cloudwatch:us-east-1:123456789012:alarm:nusend-demo-sns-redrive-failed",
      "arn:aws:cloudwatch:us-east-1:123456789012:alarm:nusend-demo-dlq-visible-messages",
    ]);
  });
});
