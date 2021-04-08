import boto3
import os
import cfnresponse

def lambda_handler(event, context):
    try:
        responseData = {}
        physicalResourceId = {}

        s3 = boto3.resource('s3')
        contentBucket = s3.Bucket(os.environ['CONTENT_BUCKET'])
        existingContentBucket = s3.Bucket(os.environ['EXISTING_CONTENT_BUCKET'])

        # Check if this is a Delete
        if event['RequestType'] == 'Delete':
          contentBucket.objects.all().delete()
          existingContentBucket.objects.all().delete()
          cfnresponse.send(event, context, cfnresponse.SUCCESS, responseData, physicalResourceId )
          return

        #creating folders in content bucket
        s3.Object(os.environ['CONTENT_BUCKET'], "labels/").put()
        s3.Object(os.environ['CONTENT_BUCKET'], "faces/").put()
        s3.Object(os.environ['CONTENT_BUCKET'], "moderation/").put()
        s3.Object(os.environ['CONTENT_BUCKET'], "text/").put()
        s3.Object(os.environ['CONTENT_BUCKET'], "celebrities/").put()

        #creating folders in existing content bucket
        s3.Object(os.environ['EXISTING_CONTENT_BUCKET'], "labels/").put()
        s3.Object(os.environ['EXISTING_CONTENT_BUCKET'], "faces/").put()
        s3.Object(os.environ['EXISTING_CONTENT_BUCKET'], "moderation/").put()
        s3.Object(os.environ['EXISTING_CONTENT_BUCKET'], "text/").put()
        s3.Object(os.environ['EXISTING_CONTENT_BUCKET'], "celebrities/").put()

        cfnresponse.send(event, context, cfnresponse.SUCCESS, responseData, physicalResourceId)

    except Exception as e:
        # cfnresponse's error message is always "see CloudWatch"
        cfnresponse.send(event, context, cfnresponse.SUCCESS, responseData, physicalResourceId)