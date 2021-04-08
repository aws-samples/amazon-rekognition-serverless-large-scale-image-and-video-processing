import boto3
from decimal import Decimal
import json
import os
from helper import AwsHelper, S3Helper, DynamoDBHelper
import datastore

def callRekognition(bucketName, objectName, apiName):
    rekognition = AwsHelper().getClient('rekognition')
    
    if(apiName == "labels"):
        response = rekognition.detect_labels(
            Image={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            }
        )
    elif (apiName == "text"):
        response = rekognition.detect_text(
            Image={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            }
        )
    elif (apiName == "faces"):
        response = rekognition.detect_faces(
            Image={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            }
        )
    elif (apiName == "moderation"):
        response = rekognition.detect_moderation_labels(
            Image={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            }
        )
    elif (apiName == "celebrities"):
        response = rekognition.recognize_celebrities(
            Image={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            }
        )
    else:
        response = rekognition.detect_labels(
            Image={
                'S3Object': {
                    'Bucket': bucketName,
                    'Name': objectName
                }
            }
        )
    return response


def processImage(documentId, bucketName, objectName, outputBucketName, documentsTableName):

    
    apiName = objectName.split("/")[0]

    response = callRekognition(bucketName, objectName, apiName)

    print("Generating output for DocumentId: {}".format(documentId))
    print(response)

    outputPath = "sync/{}-analysis/{}/".format(objectName, documentId)
    opath = "{}response.json".format(outputPath)
    S3Helper.writeToS3(json.dumps(response), outputBucketName, opath)

    #opg = OutputGenerator(documentId, response, bucketName, objectName, detectForms, detectTables, ddb)
    #opg.run()

    print("DocumentId: {}".format(documentId))

    ds = datastore.DocumentStore(documentsTableName)
    ds.markDocumentComplete(documentId)

# --------------- Main handler ------------------

def processRequest(request):

    output = ""

    print("request: {}".format(request))

    bucketName = request['bucketName']
    objectName = request['objectName']
    documentId = request['documentId']
    outputBucket = request['outputBucket']
    documentsTable = request['documentsTable']
    documentsTable = request["documentsTable"]
    
    if(documentId and bucketName and objectName):
        print("DocumentId: {}, Object: {}/{}".format(documentId, bucketName, objectName))

        processImage(documentId, bucketName, objectName, outputBucket, documentsTable)

        output = "Document: {}, Object: {}/{} processed.".format(documentId, bucketName, objectName)
        print(output)

    return {
        'statusCode': 200,
        'body': output
    }

def lambda_handler(event, context):

    print("event: {}".format(event))
    message = json.loads(event['Records'][0]['body'])
    print("Message: {}".format(message))

    request = {}
    request["documentId"] = message['documentId']
    request["bucketName"] = message['bucketName']
    request["objectName"] = message['objectName']
    request["outputBucket"] = os.environ['OUTPUT_BUCKET']
    request["documentsTable"] = os.environ['DOCUMENTS_TABLE']

    return processRequest(request)
