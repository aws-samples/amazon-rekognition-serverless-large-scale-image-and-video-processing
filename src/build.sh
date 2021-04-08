echo "Copying lambda functions..."
cp helper.py ../rekognition-pipeline/lambda/helper/python/helper.py
cp datastore.py ../rekognition-pipeline/lambda/helper/python/datastore.py
cp s3proc.py ../rekognition-pipeline/lambda/s3processor/lambda_function.py
cp s3batchproc.py ../rekognition-pipeline/lambda/s3batchprocessor/lambda_function.py
cp itemproc.py ../rekognition-pipeline/lambda/itemprocessor/lambda_function.py
cp syncproc.py ../rekognition-pipeline/lambda/syncprocessor/lambda_function.py
cp asyncproc.py ../rekognition-pipeline/lambda/asyncprocessor/lambda_function.py
cp jobresultsproc.py ../rekognition-pipeline/lambda/jobresultprocessor/lambda_function.py
cp s3FolderCreator.py ../rekognition-pipeline/lambda/s3FolderCreator/lambda_function.py

echo "Done!"